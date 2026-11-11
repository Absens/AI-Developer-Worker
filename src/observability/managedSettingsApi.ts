import type { ManagedSettingsService } from "../domain/settings/service.js";
import { SettingsError } from "../domain/settings/types.js";
import { object, revision } from "../domain/settings/validation.js";

/** Authentication and bounded JSON parsing are performed by the existing human API. */
export const handleManagedSettingsRequest = async (
  service: ManagedSettingsService, method: string, route: string, url: URL,
  actor: string, input?: unknown,
): Promise<{ status: number; body: unknown }> => {
  if (method === "GET" && route === "/settings") return { status: 200, body: await service.view() };
  const repoList = route.match(/^\/settings\/connections\/([^/]+)\/repositories$/);
  if (method === "GET" && repoList) {
    return { status: 200, body: await service.repositories(repoList[1]!, Number(url.searchParams.get("page") ?? 1)) };
  }
  if (!["POST", "PUT"].includes(method)) throw new SettingsError(405, "Метод не поддерживается.");
  const body = object(input); const expected = revision(body.expectedRevision);
  let status = 200;
  if (method === "POST" && route === "/settings/connections") {
    await service.addConnection(body, expected, actor); status = 201;
  } else if (method === "POST" && /^\/settings\/connections\/[^/]+\/rotate$/.test(route)) {
    await service.rotateConnection(route.split("/")[3]!, body.token, expected, actor);
  } else if (method === "POST" && route === "/settings/projects") {
    await service.saveProject(undefined, body.definition, expected, actor); status = 201;
  } else if (method === "PUT" && /^\/settings\/projects\/[^/]+$/.test(route)) {
    await service.saveProject(route.split("/")[3]!, body.definition, expected, actor);
  } else if (method === "POST" && /^\/settings\/projects\/[^/]+\/state$/.test(route)) {
    if (typeof body.enabled !== "boolean") throw new SettingsError(400, "Нужно явно указать enabled.");
    await service.setEnabled(route.split("/")[3]!, body.enabled, expected, actor);
  } else throw new SettingsError(404, "Маршрут настройки не найден.");
  return { status, body: await service.view() };
};
