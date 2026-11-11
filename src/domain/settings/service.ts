import { randomUUID } from "node:crypto";
import { TokenCipher } from "./tokenCipher.js";
import { object, revision, string, validateDefinition, validateOrigin } from "./validation.js";
import { SettingsError, type ManagedProject, type SettingsDocument, type SettingsGateway, type SettingsStore, type SettingsWorkspace } from "./types.js";

export class ManagedSettingsService {
  constructor(
    readonly store: SettingsStore,
    private readonly cipher: TokenCipher,
    private readonly gateway: SettingsGateway,
    readonly workspace: SettingsWorkspace,
    private readonly allowedOrigins: string[],
  ) {}

  async view() {
    const data = await this.store.read();
    return { revision: data.revision, connections: data.connections.map(c => ({ id: c.id, name: c.name, origin: c.origin, revision: c.revision, credentialConfigured: true })),
      projects: data.projects, workers: await this.store.workers(), allowedOrigins: this.allowedOrigins };
  }

  async addConnection(input: unknown, expected: number, actor: string): Promise<void> {
    revision(expected);
    const value = object(input);
    const name = string(value.name, "name", 120);
    const origin = validateOrigin(value.origin, this.allowedOrigins);
    const token = string(value.token, "token", 4096);
    await this.checkConnection(origin, token);
    const id = randomUUID(); const encryptedToken = this.cipher.seal(token, id);
    await this.store.change(expected, actor, "connection_created", data => {
      data.connections.push({ id, name, origin, encryptedToken, revision: 1 });
    });
  }

  async rotateConnection(id: string, newToken: unknown, expected: number, actor: string): Promise<void> {
    revision(expected);
    const token = string(newToken, "token", 4096);
    const document = await this.store.read();
    const connection = this.connection(document, id);
    await this.checkConnection(connection.origin, token);
    // A valid account token may still lack access to projects using this connection.
    try {
      for (const project of document.projects) {
        if (project.enabled && project.active?.definition.connectionId === id) {
          await this.gateway.project(connection.origin, token, project.active.definition.gitlabProjectId, project.active.definition.baseBranch);
        }
      }
    } catch { throw new SettingsError(502, "Новый токен не подтвердил доступ к действующим проектам. Прежний токен сохранён."); }
    await this.store.change(expected, actor, "connection_rotated", data => {
      const current = this.connection(data, id);
      current.encryptedToken = this.cipher.seal(token, id); current.revision++;
      for (const project of data.projects) {
        if (project.desired.connectionId === id && project.enabled) project.status = "pending";
      }
    });
  }

  async repositories(id: string, page = 1) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new SettingsError(400, "Некорректная страница.");
    const c = this.connection(await this.store.read(), id);
    try { return await this.gateway.repositories(c.origin, this.cipher.open(c.encryptedToken, c.id), page); }
    catch { throw new SettingsError(502, "Не удалось получить проекты GitLab. Проверьте подключение."); }
  }

  async saveProject(id: string | undefined, input: unknown, expected: number, actor: string): Promise<void> {
    revision(expected); const definition = validateDefinition(input);
    await this.store.change(expected, actor, id ? "project_updated" : "project_created", data => {
      this.connection(data, definition.connectionId);
      if (!id) {
        if (data.projects.some(p => p.desired.connectionId === definition.connectionId && p.desired.gitlabProjectId === definition.gitlabProjectId)) {
          throw new SettingsError(409, "Этот репозиторий уже зарегистрирован.");
        }
        data.projects.push({ id: randomUUID(), revision: 1, desired: definition, enabled: false, status: "draft" });
      } else {
        const project = this.project(data, id);
        if (project.desired.connectionId !== definition.connectionId || project.desired.gitlabProjectId !== definition.gitlabProjectId) {
          throw new SettingsError(400, "Нельзя сменить репозиторий существующего проекта. Создайте новый проект.");
        }
        project.desired = definition; project.revision++;
        project.status = project.enabled ? "pending" : "draft"; delete project.lastError;
      }
    });
  }

  async setEnabled(id: string, enabled: boolean, expected: number, actor: string): Promise<void> {
    revision(expected);
    if (typeof enabled !== "boolean") throw new SettingsError(400, "enabled должен быть boolean.");
    await this.store.change(expected, actor, enabled ? "project_apply_requested" : "project_paused", data => {
      const project = this.project(data, id);
      project.enabled = enabled; project.status = enabled ? "pending" : "paused"; delete project.lastError;
    });
  }

  /** Invoked at a worker boundary, never concurrently with execution of this checkout. */
  async applyPending(id: string, checkExecutor: (path: string) => Promise<void> = async () => {}): Promise<void> {
    const data = await this.store.read(); const project = this.project(data, id);
    if (!project.enabled || project.status !== "pending") return;
    const candidate = structuredClone(project);
    try {
      const connection = this.connection(data, candidate.desired.connectionId);
      const token = this.cipher.open(connection.encryptedToken, connection.id);
      const remote = await this.gateway.project(connection.origin, token, candidate.desired.gitlabProjectId, candidate.desired.baseBranch);
      await this.workspace.prepare(id, remote, { origin: connection.origin, token });
      await checkExecutor(this.workspace.pathFor(id));
      await this.store.change(undefined, "worker", "project_applied", current => {
        const target = this.project(current, id);
        if (target.revision !== candidate.revision || !target.enabled || this.connection(current, connection.id).revision !== connection.revision) {
          throw new SettingsError(409, "Настройки изменились во время проверки.");
        }
        target.active = { revision: candidate.revision, definition: candidate.desired, cloneUrl: remote.cloneUrl };
        target.status = "ready"; delete target.lastError;
      });
    } catch (error) {
      if (error instanceof SettingsError && error.status === 409) return;
      await this.store.change(undefined, "worker", "project_apply_failed", current => {
        const target = this.project(current, id);
        if (target.revision !== candidate.revision || !target.enabled) return;
        target.status = "error";
        target.lastError = "Не удалось подготовить проект или проверить Codex. Проверьте доступ, ветку, checkout и авторизацию исполнителя. Предыдущая действующая версия сохранена.";
      });
    }
  }

  async catalog() {
    return (await this.store.read()).projects.filter(p => p.enabled && p.active).map(p => ({
      id: p.id, name: p.desired.name, repositoryName: p.id, repoPathKey: p.id,
      baseBranch: p.active!.definition.baseBranch, queue: "MANAGED", tags: ["ai_dev"],
    }));
  }

  /** Server-only runtime snapshot. Never pass this object to json(). */
  async executionSnapshot(id: string) {
    const data = await this.store.read(); const project = this.project(data, id);
    if (!project.enabled || !project.active) return undefined;
    const connection = this.connection(data, project.active.definition.connectionId);
    return { project: structuredClone(project), active: structuredClone(project.active),
      connection: { id: connection.id, origin: connection.origin, revision: connection.revision,
        token: this.cipher.open(connection.encryptedToken, connection.id) } };
  }

  private async checkConnection(origin: string, token: string): Promise<void> {
    try { await this.gateway.checkConnection(origin, token); }
    catch { throw new SettingsError(400, "Не удалось проверить подключение GitLab. Проверьте адрес и токен."); }
  }
  private connection(data: SettingsDocument, id: string) {
    const value = data.connections.find(c => c.id === id);
    if (!value) throw new SettingsError(404, "Подключение не найдено.");
    return value;
  }
  private project(data: SettingsDocument, id: string): ManagedProject {
    const value = data.projects.find(p => p.id === id);
    if (!value) throw new SettingsError(404, "Проект не найден.");
    return value;
  }
}
