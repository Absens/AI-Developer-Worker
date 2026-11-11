import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { GitLabRepository, SettingsWorkspace } from "../../domain/settings/types.js";
import { buildExecutionEnvironment } from "../../utils/executionEnvironment.js";
import { runCommand, type CommandOptions } from "../../utils/shell.js";
import type { ProcessResult } from "../../models/types.js";
import { safeCloneUrl } from "./gitlab.js";

export class ManagedWorkspace implements SettingsWorkspace {
  private readonly root: string;
  constructor(root: string, private readonly execute: (options: CommandOptions) => Promise<ProcessResult> = runCommand) {
    if (!isAbsolute(root)) throw new Error("SETTINGS_WORKSPACE_ROOT must be absolute.");
    this.root = resolve(root);
  }
  pathFor(id: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid managed project ID.");
    return join(this.root, id);
  }
  async prepare(id: string, remote: GitLabRepository, connection: { origin: string; token: string }): Promise<void> {
    const cloneUrl = safeCloneUrl(remote.cloneUrl, connection.origin);
    const path = this.pathFor(id);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (await realpath(this.root) !== this.root) throw new Error("Workspace root must not contain symlinks.");
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || await realpath(path) !== path)) throw new Error("Invalid checkout path.");
    const auth = Buffer.from(`oauth2:${connection.token}`).toString("base64");
    const env: NodeJS.ProcessEnv = { ...buildExecutionEnvironment("git", {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_0: `http.${connection.origin}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${auth}`,
      GIT_CONFIG_KEY_1: "http.followRedirects", GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "credential.helper", GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_KEY_3: "core.hooksPath", GIT_CONFIG_VALUE_3: "/dev/null",
    }), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const run = async (args: string[], cwd: string): Promise<string> => {
      const result = await this.execute({ command: "git", args, cwd, env, timeoutMs: 120_000, maxBufferBytes: 16384 });
      if (result.exitCode !== 0 || result.timedOut) throw new Error("Managed checkout operation failed. Inspect the worker workspace.");
      return result.stdout.trim();
    };
    if (!existing) {
      // No hooks, submodules, package installers or user-defined scripts run during onboarding.
      await run(["-c", "protocol.file.allow=never", "clone", "--no-recurse-submodules", "--", cloneUrl, path], this.root);
    }
    const gitDir = await lstat(join(path, ".git"));
    if (!gitDir.isDirectory() || gitDir.isSymbolicLink()) throw new Error("Managed checkout needs an ordinary .git directory.");
    const storedRemote = await run(["remote", "get-url", "origin"], path);
    if (storedRemote !== cloneUrl) throw new Error("Existing checkout belongs to another remote; no reset performed.");
    // Never checkout/reset/fetch an existing task branch during settings validation.
    await run(["ls-remote", "--exit-code", "origin", "HEAD"], path);
  }
}
