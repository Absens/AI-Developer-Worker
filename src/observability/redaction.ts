const SECRET_VALUE = "[redacted]";
const DEFAULT_MAX_CHARS = 4000;

const redactString = (input: string, maxChars: number): string => {
  let value = input;
  value = value.replace(
    /\b([A-Z0-9_]*(?:TOKEN|KEY|PASSWORD|SECRET)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    `$1=${SECRET_VALUE}`,
  );
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${SECRET_VALUE}`);
  value = value.replace(
    /\b(Authorization\s*:\s*)(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
    `$1$2 ${SECRET_VALUE}`,
  );
  value = value.replace(
    /\bhttps?:\/\/([^/\s:@]+):([^@\s/]+)@/gi,
    (_match, user: string) => `https://${user}:${SECRET_VALUE}@`,
  );
  value = value.replace(
    /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi,
    SECRET_VALUE,
  );
  value = value.replace(
    /\bhttps:\/\/api\.telegram\.org\/bot[A-Za-z0-9:_-]+\/[A-Za-z0-9/_-]+/gi,
    SECRET_VALUE,
  );
  value = value.replace(/\b(?:CODEX_HOME=)?[A-Za-z]:\\[^ \n\r]*\.codex[^ \n\r]*/gi, SECRET_VALUE);
  value = value.replace(/\b(?:CODEX_HOME=)?\/[^ \n\r]*\.codex[^ \n\r]*/gi, SECRET_VALUE);

  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n[diagnostic truncated after ${maxChars} characters]`;
};

export const redactSecrets = <T>(value: T, maxChars = DEFAULT_MAX_CHARS): T => {
  if (typeof value === "string") {
    return redactString(value, maxChars) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, maxChars)) as T;
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        /(token|password|secret|authorization|webhook)/i.test(key) ||
        /(?:api|private|access|secret)key/i.test(key)
      ) {
        result[key] = SECRET_VALUE;
        continue;
      }
      result[key] = redactSecrets(entry, maxChars);
    }
    return result as T;
  }

  return value;
};
