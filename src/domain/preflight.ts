import type {
  AppConfig,
  GitLabService,
  GitService,
  PreflightCheckResult,
  TrackerClient,
} from "../models/types.js";
import { Logger } from "../utils/logger.js";
import { runShellCommand } from "../utils/shell.js";
import type { ProcessResult } from "../models/types.js";

type ShellCommandRunner = (
  command: string,
  options: { cwd: string },
) => Promise<ProcessResult>;

const buildCommandFailure = (
  label: string,
  command: string,
  result: ProcessResult,
): string =>
  [
    `${label} failed with exit code ${result.exitCode}: ${command}`,
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const hasPreflightFailures = (checks: PreflightCheckResult[]): boolean =>
  checks.some((check) => check.status === "fail");

export const formatPreflightReport = (checks: PreflightCheckResult[]): string =>
  [
    "Preflight report:",
    ...checks.map(
      (check) => `${check.status.toUpperCase()} ${check.name}: ${check.details}`,
    ),
  ].join("\n");

export class PreflightService {
  constructor(
    private readonly config: AppConfig,
    private readonly tracker: TrackerClient,
    private readonly git: GitService,
    private readonly gitlab: GitLabService,
    private readonly assertCodexAuthenticated: () => Promise<void>,
    private readonly logger: Logger,
    private readonly commandRunner: ShellCommandRunner = runShellCommand,
  ) {}

  async run(): Promise<PreflightCheckResult[]> {
    const checks: PreflightCheckResult[] = [
      {
        name: "Config load",
        status: "pass",
        details: "Configuration and Tracker status map loaded successfully.",
      },
    ];
    const internalTracker =
      this.config.taskTracker?.provider === "internal"
        ? this.config.taskTracker.internal
        : undefined;

    if (internalTracker) {
      checks.push({
        name: "Internal tracker storage",
        status: "pass",
        details:
          internalTracker.storage === "postgres"
            ? "PostgreSQL storage is configured for the internal task tracker."
            : "In-memory internal task tracker storage is configured for test/local smoke.",
      });

      if (internalTracker.yandexSyncEnabled) {
        checks.push({
          name: "Yandex sync bridge",
          status: "fail",
          details:
            "YANDEX_SYNC_ENABLED=true is parsed, but the Yandex bridge is scheduled for Phase 7E and is not available in Phase 7C.",
        });
      }
    }

    await this.record(checks, "Codex auth", this.assertCodexAuthenticated, () =>
      `Codex authentication is available for CODEX_HOME=${this.config.codexHome}.`,
    );
    await this.record(checks, "Git repository", () => this.git.assertRepositoryReady(), () =>
      `Repository is ready at ${this.config.repoPath}.`,
    );
    if (!internalTracker) {
      await this.record(checks, "Tracker read", () => this.checkTrackerRead(), () =>
        this.config.trackerPreflightIssueKey
          ? `Read access verified with issue ${this.config.trackerPreflightIssueKey}.`
          : `Read access verified with queue ${this.config.trackerDefaultQueue} and tag ${this.config.trackerTag}.`,
      );
      await this.record(checks, "Tracker write", () => this.checkTrackerWrite(), (details) =>
        details,
      );
    }
    await this.record(checks, "GitLab read", () => this.gitlab.checkReadAccess(), () =>
      `Read access verified for GitLab project ${this.config.gitlabProjectId}.`,
    );
    await this.record(checks, "GitLab write", () => this.checkGitLabWrite(), (details) =>
      details,
    );
    await this.record(checks, "Target commands", () => this.checkTargetCommands(), (details) =>
      details,
    );

    this.logger.info("Preflight checks completed.", {
      checks,
      failed: hasPreflightFailures(checks),
    });
    return checks;
  }

  private async record<T extends string | void>(
    checks: PreflightCheckResult[],
    name: string,
    run: () => Promise<T>,
    passDetails: (value: T) => string,
  ): Promise<void> {
    try {
      const details = await run();
      checks.push({
        name,
        status: "pass",
        details: passDetails(details),
      });
    } catch (error) {
      if (error instanceof PreflightWarning) {
        checks.push({
          name,
          status: "warn",
          details: error.message,
        });
        return;
      }

      checks.push({
        name,
        status: "fail",
        details: formatError(error),
      });
    }
  }

  private async checkTrackerRead(): Promise<void> {
    if (this.config.trackerPreflightIssueKey) {
      await this.tracker.getIssue(this.config.trackerPreflightIssueKey);
      return;
    }

    await this.tracker.checkReadAccess();
  }

  private async checkTrackerWrite(): Promise<string> {
    if (!this.config.trackerPreflightIssueKey) {
      throw new PreflightWarning(
        "Skipped write check. Set TRACKER_PREFLIGHT_ISSUE_KEY to allow a neutral sandbox comment.",
      );
    }

    await this.tracker.addComment(
      this.config.trackerPreflightIssueKey,
      `AI preflight check by ${this.config.workerId}: Tracker comment permission verified.`,
    );
    return `Neutral preflight comment added to ${this.config.trackerPreflightIssueKey}.`;
  }

  private async checkGitLabWrite(): Promise<string> {
    if (!this.config.gitlabPreflightSourceBranch) {
      throw new PreflightWarning(
        "Skipped write check. Set GITLAB_PREFLIGHT_SOURCE_BRANCH to allow a sandbox draft merge request check.",
      );
    }

    const mergeRequest = await this.gitlab.checkMergeRequestWriteAccess(
      this.config.gitlabPreflightSourceBranch,
    );
    return `Draft/test merge request write access verified for ${mergeRequest.sourceBranch}: ${mergeRequest.url}.`;
  }

  private async checkTargetCommands(): Promise<string> {
    if (!this.config.preflightRunTargetCommands) {
      throw new PreflightWarning(
        "Skipped target repository commands because PREFLIGHT_RUN_TARGET_COMMANDS=false.",
      );
    }

    const testResult = await this.commandRunner(this.config.testCommand, {
      cwd: this.config.repoPath,
    });
    if (testResult.exitCode !== 0) {
      throw new Error(buildCommandFailure("TEST_COMMAND", this.config.testCommand, testResult));
    }

    const lintResult = await this.commandRunner(this.config.lintCommand, {
      cwd: this.config.repoPath,
    });
    if (lintResult.exitCode !== 0) {
      throw new Error(buildCommandFailure("LINT_COMMAND", this.config.lintCommand, lintResult));
    }

    return "TEST_COMMAND and LINT_COMMAND completed successfully.";
  }
}

class PreflightWarning extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightWarning";
  }
}
