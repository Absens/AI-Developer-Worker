import { runCommand, type CommandOptions } from "../../utils/shell.js";
import type { ProcessResult } from "../../models/types.js";
interface ExecutorProbe { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
/** Bounded local capability/auth checks; intentionally makes no paid model request. */
export const checkManagedExecutor = async (
  input: ExecutorProbe,
  run: (options: CommandOptions) => Promise<ProcessResult> = runCommand,
): Promise<void> => {
  const commands = input.env.CODEX_API_KEY?.trim() ? [["--version"]] : [["--version"], ["login", "status"]];
  try {
    for (const command of commands) {
      const result = await run({ command: input.command, args: [...input.args, ...command], cwd: input.cwd, env: input.env,
        timeoutMs: 15_000, maxBufferBytes: 4096 });
      if (result.exitCode !== 0 || result.timedOut) throw new Error("probe failed");
    }
  } catch { throw new Error("Исполнитель недоступен или не авторизован. Проверьте Codex CLI и отдельный CODEX_HOME."); }
};
