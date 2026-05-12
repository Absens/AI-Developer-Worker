import { Pool } from "pg";

import { assertInternalTrackerOperational } from "../integrations/internalTracker/index.js";
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

type InternalTrackerChecker = (databaseUrl: string) => Promise<void>;

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

const quoteShellArg = (value: string): string => {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
};

const buildCodexExecHelpCommand = (config: AppConfig): string =>
  [config.codexCliCommand, ...config.codexCliArgs, "exec", "--help"]
    .map(quoteShellArg)
    .join(" ");

const defaultInternalTrackerChecker: InternalTrackerChecker = async (databaseUrl) => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await assertInternalTrackerOperational(pool);
  } finally {
    await pool.end();
  }
};

const isLoopbackHost = (host: string): boolean =>
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "::1" ||
  host === "[::1]";

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
    private readonly internalTrackerChecker: InternalTrackerChecker = defaultInternalTrackerChecker,
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
        status: internalTracker.storage === "memory" ? "fail" : "pass",
        details:
          internalTracker.storage === "postgres"
            ? "PostgreSQL storage is configured for the internal task tracker."
            : "In-memory storage is not allowed for production internal tracker preflight.",
      });

      if (internalTracker.storage === "postgres") {
        await this.record(
          checks,
          "Internal tracker migrations",
          () => this.internalTrackerChecker(internalTracker.databaseUrl),
          () => "Database connection, applied migrations, required tables/indexes, and SKIP LOCKED claim support are available.",
        );
      }

      this.checkOperationalAuthAlignment(checks);

      if (internalTracker.yandexSyncEnabled) {
        checks.push({
          name: "Yandex sync bridge",
          status: "pass",
          details:
            "YANDEX_SYNC_ENABLED=true is configured; Yandex is used as an external source/mirror for internal tasks.",
        });
      }
    }

    this.checkNotificationSinks(checks);

    await this.record(checks, "Codex auth", this.assertCodexAuthenticated, () =>
      `Codex authentication is available for CODEX_HOME=${this.config.codexHome}.`,
    );
    if (this.config.trackerImageContext?.enabled) {
      await this.record(checks, "Codex image input", () => this.checkCodexImageInput(), (details) =>
        details,
      );
    }
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

  private checkOperationalAuthAlignment(checks: PreflightCheckResult[]): void {
    const observability = this.config.observability;
    if (!observability) {
      return;
    }
    const exposed = !isLoopbackHost(observability.host);
    const ui = observability.taskTrackerUi;
    if (ui.enabled && exposed && ui.authMode === "localhost") {
      checks.push({
        name: "Task tracker UI auth",
        status: "fail",
        details:
          "TASK_TRACKER_HUMAN_AUTH_MODE=localhost cannot be used when TASK_TRACKER_UI_BIND_HOST exposes the UI outside localhost.",
      });
      return;
    }
    if (ui.enabled && exposed && (!ui.systemToken || !ui.agentToken)) {
      checks.push({
        name: "Task tracker UI auth",
        status: "fail",
        details:
          "TASK_TRACKER_SYSTEM_TOKEN and TASK_TRACKER_AGENT_TOKEN are required when the internal tracker UI/API is exposed outside localhost.",
      });
      return;
    }
    if (ui.enabled) {
      checks.push({
        name: "Task tracker UI auth",
        status: "pass",
        details: exposed
          ? "Task tracker UI/API auth is configured for a non-localhost bind host."
          : "Task tracker UI/API is bound to localhost or disabled for remote exposure.",
      });
    }

    if (observability.dashboard.enabled && exposed && !observability.dashboard.bearerToken) {
      checks.push({
        name: "Dashboard auth",
        status: "fail",
        details:
          "DASHBOARD_BEARER_TOKEN is required when the observability dashboard is exposed outside localhost.",
      });
      return;
    }
    if (observability.dashboard.enabled) {
      checks.push({
        name: "Dashboard auth",
        status: "pass",
        details: exposed
          ? "Dashboard bearer auth is configured for a non-localhost bind host."
          : "Dashboard is bound to localhost or protected by its configured auth.",
      });
    }
  }

  private checkNotificationSinks(checks: PreflightCheckResult[]): void {
    const alerts = this.config.observability?.alerts;
    if (!alerts?.enabled) {
      return;
    }
    const missing: string[] = [];
    for (const channel of alerts.channels) {
      if (channel.type === "webhook" && !channel.url) {
        missing.push("webhook.url");
      }
      if (channel.type === "slack" && !channel.webhookUrl) {
        missing.push("slack.webhookUrl");
      }
      if (channel.type === "telegram" && (!channel.botToken || !channel.chatId)) {
        missing.push("telegram.botToken/chatId");
      }
    }

    checks.push({
      name: "Notification sinks",
      status: missing.length > 0 ? "fail" : "pass",
      details:
        missing.length > 0
          ? `Missing alert notification sink settings: ${missing.join(", ")}.`
          : "Configured alert notification sinks have required credentials.",
    });
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

  private async checkCodexImageInput(): Promise<string> {
    const command = buildCodexExecHelpCommand(this.config);
    const result = await this.commandRunner(command, {
      cwd: this.config.repoPath,
    });
    if (result.exitCode !== 0) {
      throw new Error(buildCommandFailure("CODEX_IMAGE_INPUT_HELP", command, result));
    }
    if (!result.stdout.includes("--image")) {
      throw new Error(
        "TRACKER_IMAGE_CONTEXT_ENABLED=true requires a Codex CLI version whose `codex exec --help` includes --image.",
      );
    }

    return "Codex CLI supports image inputs through codex exec --image.";
  }
}

class PreflightWarning extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightWarning";
  }
}
