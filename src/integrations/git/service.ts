import type { AppConfig, GitService } from "../../models/types.js";
import { PermanentTaskError } from "../../utils/errors.js";
import { Logger } from "../../utils/logger.js";
import { runShellCommand } from "../../utils/shell.js";

const branchNameForIssue = (issueKey: string): string => `feature/ai-task-${issueKey}`;

const trimOutput = (text: string): string => text.trim();

export class RepositoryGitService implements GitService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

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
      await this.ensureSuccess("git fetch --all --prune");
      return branch;
    }

    await this.syncBaseBranch();

    const localBranchCheck = await this.run(`git branch --list ${branch}`);
    if (trimOutput(localBranchCheck.stdout) !== "") {
      await this.ensureSuccess(`git checkout ${branch}`);
      return branch;
    }

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
    await this.ensureSuccess(`git push -u origin ${branch}`);
  }

  private async ensureSuccess(command: string): Promise<void> {
    const result = await this.run(command);
    if (result.exitCode !== 0) {
      throw new Error(`Command failed: ${command}\n${result.stderr || result.stdout}`);
    }
  }

  private run(command: string) {
    this.logger.info("Running git command.", { command });
    return runShellCommand(command, {
      cwd: this.config.repoPath,
    });
  }
}
