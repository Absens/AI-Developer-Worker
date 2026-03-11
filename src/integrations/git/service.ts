import type { AppConfig, GitService } from "../../models/types.js";
import { ConfigurationError, PermanentTaskError } from "../../utils/errors.js";
import { Logger } from "../../utils/logger.js";
import { runShellCommand } from "../../utils/shell.js";

const branchNameForIssue = (issueKey: string): string => `feature/ai-task-${issueKey}`;

const trimOutput = (text: string): string => text.trim();
const escapeDoubleQuotes = (text: string): string => text.replace(/"/g, '\\"');
const sanitizeRemoteOutput = (text: string): string =>
  text.replace(/https:\/\/([^@\s]+)@/g, "https://***@");
const isHttpRemote = (value: string): boolean => /^https?:\/\//i.test(value);
const isLocalRemote = (value: string): boolean =>
  /^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/]|\/)/.test(value) || value.startsWith("file://");

const convertRemoteToHttps = (value: string): string | null => {
  const sshLikeMatch = value.match(/^git@([^:]+):(.+)$/);
  if (sshLikeMatch) {
    return `https://${sshLikeMatch[1]}/${sshLikeMatch[2]}`;
  }

  const sshUrlMatch = value.match(/^ssh:\/\/(?:.+@)?([^/]+)\/(.+)$/);
  if (sshUrlMatch) {
    return `https://${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
  }

  if (isHttpRemote(value)) {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      return url.toString();
    } catch {
      return value;
    }
  }

  return null;
};

export class RepositoryGitService implements GitService {
  private remoteAuthEnv: NodeJS.ProcessEnv | undefined;
  private repositoryPrepared = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async assertRepositoryReady(): Promise<void> {
    await this.ensureRepositoryPrepared();
    await this.ensureCommitIdentity();
    const remoteList = await this.run("git remote -v");
    if (remoteList.exitCode === 0) {
      this.logger.info("Detected repository remotes.", {
        remotes: sanitizeRemoteOutput(trimOutput(remoteList.stdout)),
      });
    }
    await this.ensureSuccess("git fetch --all --prune");
  }

  async getCurrentBranch(): Promise<string> {
    const result = await this.run("git rev-parse --abbrev-ref HEAD");
    if (result.exitCode !== 0) {
      throw new Error(`Unable to determine current branch: ${result.stderr}`);
    }
    return trimOutput(result.stdout);
  }

  async hasChanges(): Promise<boolean> {
    const result = await this.run("git status --porcelain");
    if (result.exitCode !== 0) {
      throw new Error(`Unable to inspect git status: ${result.stderr}`);
    }
    return trimOutput(result.stdout) !== "";
  }

  async hasDiffFromBase(): Promise<boolean> {
    const result = await this.run(`git diff --quiet ${this.config.baseBranch}...HEAD`);
    if (result.exitCode === 0) {
      return false;
    }
    if (result.exitCode === 1) {
      return true;
    }
    throw new Error(`Unable to compare with base branch: ${result.stderr}`);
  }

  async syncBaseBranch(): Promise<void> {
    await this.ensureRepositoryPrepared();
    await this.ensureSuccess("git fetch --all --prune");
    await this.ensureSuccess(`git checkout ${this.config.baseBranch}`);
    await this.ensureSuccess(`git pull origin ${this.config.baseBranch}`);
  }

  async checkoutTaskBranch(issueKey: string): Promise<string> {
    const branch = branchNameForIssue(issueKey);
    const currentBranch = await this.getCurrentBranch();
    const dirty = await this.hasChanges();

    if (dirty && currentBranch !== branch) {
      throw new PermanentTaskError(
        `Repository has uncommitted changes on ${currentBranch}; refusing to switch tasks.`,
      );
    }

    if (currentBranch === branch && dirty) {
      this.logger.warn("Continuing on dirty task branch after restart.", { branch });
      await this.ensureRepositoryPrepared();
      await this.ensureSuccess("git fetch --all --prune");
      return branch;
    }

    await this.syncBaseBranch();

    const localBranchCheck = await this.run(`git branch --list ${branch}`);
    if (trimOutput(localBranchCheck.stdout) !== "") {
      await this.ensureSuccess(`git checkout ${branch}`);
      return branch;
    }

    await this.ensureRepositoryPrepared();
    const remoteBranchCheck = await this.run(`git ls-remote --heads origin ${branch}`);
    if (trimOutput(remoteBranchCheck.stdout) !== "") {
      await this.ensureSuccess(`git checkout -b ${branch} origin/${branch}`);
      return branch;
    }

    await this.ensureSuccess(`git checkout -b ${branch}`);
    return branch;
  }

  async commit(message: string): Promise<void> {
    await this.ensureSuccess("git add -A");
    await this.ensureSuccess(`git commit -m "${message.replace(/"/g, '\\"')}"`);
  }

  async push(branch: string): Promise<void> {
    await this.ensureRepositoryPrepared();
    await this.ensureSuccess(`git push -u origin ${branch}`);
  }

  private async ensureSuccess(command: string): Promise<void> {
    const result = await this.run(command);
    if (result.exitCode !== 0) {
      throw new Error(`Command failed: ${command}\n${result.stderr || result.stdout}`);
    }
  }

  private async ensureRepositoryPrepared(): Promise<void> {
    if (this.repositoryPrepared) {
      return;
    }

    const remoteName = this.config.gitRemoteName;
    const fetchUrl = await this.getRemoteUrl(remoteName);
    const pushUrl = await this.getRemoteUrl(remoteName, true);
    const desiredFetchUrl = this.resolveDesiredRemoteUrl(fetchUrl);
    const desiredPushUrl = this.resolveDesiredRemoteUrl(pushUrl);

    if (desiredFetchUrl !== fetchUrl) {
      this.logger.warn("Rewriting git fetch remote to HTTPS for worker access.", {
        remoteName,
        from: sanitizeRemoteOutput(fetchUrl),
        to: sanitizeRemoteOutput(desiredFetchUrl),
      });
      const result = await this.run(
        `git remote set-url ${remoteName} "${escapeDoubleQuotes(desiredFetchUrl)}"`,
        undefined,
      );
      if (result.exitCode !== 0) {
        throw new ConfigurationError(
          `Unable to rewrite fetch remote ${remoteName} to HTTPS. ${result.stderr || result.stdout}`,
        );
      }
    }

    if (desiredPushUrl !== pushUrl) {
      this.logger.warn("Rewriting git push remote to HTTPS for worker access.", {
        remoteName,
        from: sanitizeRemoteOutput(pushUrl),
        to: sanitizeRemoteOutput(desiredPushUrl),
      });
      const result = await this.run(
        `git remote set-url --push ${remoteName} "${escapeDoubleQuotes(desiredPushUrl)}"`,
        undefined,
      );
      if (result.exitCode !== 0) {
        throw new ConfigurationError(
          `Unable to rewrite push remote ${remoteName} to HTTPS. ${result.stderr || result.stdout}`,
        );
      }
    }

    this.remoteAuthEnv = this.buildRemoteAuthEnv(desiredFetchUrl);
    this.repositoryPrepared = true;
  }

  private async ensureCommitIdentity(): Promise<void> {
    const result = await this.run("git var GIT_AUTHOR_IDENT");
    if (result.exitCode === 0) {
      return;
    }

    throw new ConfigurationError(
      [
        "Git commit identity is not configured for the mounted repository.",
        "Set git user.name and user.email in that repository, or provide GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL to the worker environment.",
        (result.stderr || result.stdout).trim(),
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  private async getRemoteUrl(remoteName: string, push = false): Promise<string> {
    const command = push
      ? `git remote get-url --push ${remoteName}`
      : `git remote get-url ${remoteName}`;
    const result = await this.run(command, undefined);
    if (result.exitCode !== 0) {
      throw new ConfigurationError(
        `Unable to determine git remote URL for ${remoteName}. ${result.stderr || result.stdout}`,
      );
    }

    return trimOutput(result.stdout);
  }

  private resolveDesiredRemoteUrl(currentRemoteUrl: string): string {
    if (this.config.gitRepositoryUrl) {
      return this.config.gitRepositoryUrl;
    }

    if (isLocalRemote(currentRemoteUrl)) {
      return currentRemoteUrl;
    }

    const httpsRemoteUrl = convertRemoteToHttps(currentRemoteUrl);
    if (!httpsRemoteUrl) {
      throw new ConfigurationError(
        `Unsupported git remote URL format for worker repository: ${currentRemoteUrl}`,
      );
    }

    return httpsRemoteUrl;
  }

  private buildRemoteAuthEnv(remoteUrl: string): NodeJS.ProcessEnv | undefined {
    if (!isHttpRemote(remoteUrl)) {
      return undefined;
    }

    const origin = new URL(remoteUrl).origin;
    const credentials = Buffer.from(
      `${this.config.gitRepositoryUsername}:${this.config.gitRepositoryToken}`,
      "utf8",
    ).toString("base64");

    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${credentials}`,
    };
  }

  private run(command: string, env = this.remoteAuthEnv) {
    this.logger.info("Running git command.", { command });
    return runShellCommand(command, {
      cwd: this.config.repoPath,
      env,
    });
  }
}
