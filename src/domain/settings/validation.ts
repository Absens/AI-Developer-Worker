import { SettingsError, type ProjectDefinition } from "./types.js";

export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SettingsError(400, "Ожидается объект настроек.");
  return value as Record<string, unknown>;
};
export const string = (value: unknown, label: string, max = 200): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00\r\n]/.test(value)) {
    throw new SettingsError(400, `Некорректное поле: ${label}.`);
  }
  return value.trim();
};
export const revision = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new SettingsError(400, "Нужна версия настроек (expectedRevision).");
  return value;
};
export const validateOrigin = (value: unknown, allowed: string[]): string => {
  const input = string(value, "origin", 1000);
  let url: URL;
  try { url = new URL(input); } catch { throw new SettingsError(400, "Некорректный адрес GitLab."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || !allowed.includes(url.origin)) {
    throw new SettingsError(400, "Адрес GitLab не разрешён конфигурацией сервера. Нужен HTTPS origin без пути и credentials.");
  }
  return url.origin;
};
export const validateDefinition = (input: unknown): ProjectDefinition => {
  const body = object(input);
  const fields = ["name", "connectionId", "gitlabProjectId", "baseBranch", "testCommand", "lintCommand", "buildCommand", "typeCheckCommand", "model", "timeoutSeconds", "maxFixAttempts"];
  if (Object.keys(body).some(key => !fields.includes(key))) throw new SettingsError(400, "Неизвестные поля настроек проекта.");
  const baseBranch = string(body.baseBranch, "baseBranch");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseBranch) || /\.\.|\/\/|\/$|\.$|\.lock$/.test(baseBranch)) {
    throw new SettingsError(400, "Недопустимое имя базовой ветки.");
  }
  const gitlabProjectId = string(body.gitlabProjectId, "gitlabProjectId", 20);
  if (!/^[1-9][0-9]*$/.test(gitlabProjectId)) throw new SettingsError(400, "Нужен числовой ID GitLab-проекта.");
  const boundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
    const result = value ?? fallback;
    if (typeof result !== "number" || !Number.isInteger(result) || result < min || result > max) throw new SettingsError(400, "Значение лимита вне допустимого диапазона.");
    return result;
  };
  const result: ProjectDefinition = {
    name: string(body.name, "name", 120), connectionId: string(body.connectionId, "connectionId", 80), gitlabProjectId, baseBranch,
    testCommand: string(body.testCommand, "testCommand", 4000), lintCommand: string(body.lintCommand, "lintCommand", 4000),
    timeoutSeconds: boundedInt(body.timeoutSeconds, 1800, 30, 7200), maxFixAttempts: boundedInt(body.maxFixAttempts, 2, 0, 5),
  };
  for (const key of ["buildCommand", "typeCheckCommand", "model"] as const) {
    if (body[key] !== undefined && body[key] !== "") result[key] = string(body[key], key, key === "model" ? 120 : 4000);
  }
  return result;
};
