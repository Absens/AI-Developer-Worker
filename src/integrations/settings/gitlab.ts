import type { GitLabRepository, SettingsGateway } from "../../domain/settings/types.js";
import { object, string, validateOrigin } from "../../domain/settings/validation.js";

export const safeCloneUrl = (input: unknown, origin: string): string => {
  const url = new URL(string(input, "cloneUrl", 2000));
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(".git")) {
    throw new Error("Unsafe repository URL returned by GitLab.");
  }
  return url.toString();
};

export class ManagedGitLabGateway implements SettingsGateway {
  constructor(private readonly allowedOrigins: string[], private readonly fetcher: typeof fetch = fetch) {}
  private async get(origin: string, token: string, path: string) {
    validateOrigin(origin, this.allowedOrigins);
    const response = await this.fetcher(`${origin}/api/v4/${path}`, {
      headers: { "PRIVATE-TOKEN": token, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || response.status >= 300) throw new Error("GitLab request failed.");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing GitLab response.");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2 * 1024 * 1024) throw new Error("GitLab response is too large.");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return { data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown, headers: response.headers };
  }
  async checkConnection(origin: string, token: string): Promise<void> {
    const { data } = await this.get(origin, token, "user");
    if (!object(data).id) throw new Error("GitLab user is unavailable.");
  }
  private repository(data: unknown, origin: string): GitLabRepository {
    const value = object(data);
    return { id: string(String(value.id), "projectId", 20), name: string(value.path_with_namespace ?? value.name, "name", 300),
      cloneUrl: safeCloneUrl(value.http_url_to_repo, origin), defaultBranch: typeof value.default_branch === "string" ? value.default_branch : "main" };
  }
  async repositories(origin: string, token: string, page = 1) {
    const { data, headers } = await this.get(origin, token, `projects?membership=true&archived=false&per_page=50&page=${page}&order_by=id&sort=asc`);
    if (!Array.isArray(data)) throw new Error("Invalid project list.");
    const next = Number(headers.get("x-next-page"));
    return { repositories: data.map(value => this.repository(value, origin)), nextPage: Number.isSafeInteger(next) && next > page ? next : null };
  }
  async project(origin: string, token: string, id: string, branch: string): Promise<GitLabRepository> {
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Invalid project ID.");
    const { data } = await this.get(origin, token, `projects/${id}`);
    const project = this.repository(data, origin);
    if (project.id !== id || object(data).archived === true) throw new Error("Project is not available.");
    await this.get(origin, token, `projects/${id}/repository/branches/${encodeURIComponent(branch)}`);
    return project;
  }
}
