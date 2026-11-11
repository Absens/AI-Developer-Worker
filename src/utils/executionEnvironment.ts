export type ExecutionEnvironmentProfile = "project" | "codex" | "git";

const SYSTEM_VARIABLES = [
  "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "PROGRAMW6432", "TEMP", "TMP", "TMPDIR", "USER", "LOGNAME", "USERNAME",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC", "LC_TIME",
  "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "CI",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
];

const PROFILE_VARIABLES: Record<ExecutionEnvironmentProfile, readonly string[]> = {
  project: [],
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  git: ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"],
};

const ALLOWLIST_VARIABLES: Record<ExecutionEnvironmentProfile, string> = {
  project: "WORKER_PROJECT_ENV_ALLOWLIST",
  codex: "WORKER_CODEX_ENV_ALLOWLIST",
  git: "WORKER_GIT_ENV_ALLOWLIST",
};

const INJECTION_VARIABLES = new Set([
  "NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "ZDOTDIR",
  "PYTHONPATH", "PYTHONHOME", "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
  "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE",
]);

const forbidden = (
  key: string,
  profile: ExecutionEnvironmentProfile,
  trustedOverride = false,
): boolean => {
  const name = key.toUpperCase();
  if (/^(?:__PROTO__|CONSTRUCTOR|PROTOTYPE)$/.test(name)) return true;
  if (/^(?:GITLAB_|TRACKER_|TASK_TRACKER_|TELEGRAM_|WORKER_|ALERT_|SLACK_|YANDEX_|SETTINGS_|MANAGED_)/.test(name)) return true;
  if (name === "GIT_REPOSITORY_TOKEN") return true;
  if (INJECTION_VARIABLES.has(name) || /^(?:LD_|DYLD_)/.test(name)) return true;
  if (name.startsWith("GIT_CONFIG")) {
    // Only the trusted Git adapter may inject its per-operation HTTP auth config.
    return !(trustedOverride && profile === "git" && /^GIT_CONFIG_(?:COUNT|(?:KEY|VALUE)_\d+)$/.test(name));
  }
  if (name.startsWith("CODEX_")) {
    return profile !== "codex" || !["CODEX_API_KEY", "CODEX_HOME"].includes(name);
  }
  if (/^(?:OPENAI_|ANTHROPIC_|AZURE_OPENAI_)/.test(name) || name === "GEMINI_API_KEY" || name === "GOOGLE_API_KEY") {
    return profile !== "codex";
  }
  return false;
};

/**
 * Construct a complete child-process environment. There is no implicit parent overlay.
 * Allowlist configuration belongs to the operator, never to task/model input.
 * This does not isolate HOME, files, sockets, hooks, network or other processes.
 */
export const buildExecutionEnvironment = (
  profile: ExecutionEnvironmentProfile,
  overrides: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  if (!Object.hasOwn(ALLOWLIST_VARIABLES, profile)) {
    throw new Error("Unknown execution environment profile.");
  }
  const canonical = (key: string): string => platform === "win32" ? key.toUpperCase() : key;
  const read = (key: string): string | undefined => {
    if (platform !== "win32") return Object.hasOwn(source, key) ? source[key] : undefined;
    const matches = Object.keys(source).filter((candidate) => canonical(candidate) === canonical(key));
    const values = matches.map((candidate) => source[candidate]).filter((value) => value !== undefined);
    if (new Set(values).size > 1) {
      throw new Error(`Ambiguous case-insensitive environment variable: ${key}.`);
    }
    return values[0];
  };
  const result = new Map<string, string>();
  const set = (key: string, value: string | undefined): void => {
    if (value === undefined) {
      result.delete(canonical(key));
      return;
    }
    if (value.includes("\0")) throw new Error(`Invalid environment value for ${key}.`);
    result.set(canonical(key), value);
  };

  for (const key of [...SYSTEM_VARIABLES, ...PROFILE_VARIABLES[profile]]) set(key, read(key));

  const setting = ALLOWLIST_VARIABLES[profile];
  const configured = read(setting)?.trim();
  if (configured) {
    for (const key of new Set(configured.split(",").map((value) => value.trim()))) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        // Do not echo the setting: it may accidentally contain a credential value.
        throw new Error(`${setting} must contain comma-separated exact environment names, without wildcards or assignments.`);
      }
      if (forbidden(key, profile)) throw new Error(`${setting} cannot forward reserved variable ${key}.`);
      set(key, read(key));
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || forbidden(key, profile, true)) {
      throw new Error(`Invalid or reserved environment override for ${profile}.`);
    }
    set(key, value);
  }
  return Object.fromEntries(result);
};
