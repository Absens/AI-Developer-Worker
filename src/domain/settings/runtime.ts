import { ManagedSettingsService } from "./service.js";
export type ManagedExecutionSnapshot = NonNullable<Awaited<ReturnType<ManagedSettingsService["executionSnapshot"]>>>;

/** One immutable snapshot per run; never mutates a running Codex or repository client. */
export class ManagedRuntime {
  private stopping = false;
  private wake: (() => void) | undefined;
  constructor(
    private readonly service: ManagedSettingsService,
    private readonly workerId: string,
    private readonly execute: (snapshot: ManagedExecutionSnapshot) => Promise<void>,
    private readonly checkExecutor: (path: string) => Promise<void>,
    private readonly hasAbandonedExecution: (projectId: string) => Promise<boolean>,
    private readonly intervalMs = 5_000,
  ) {}
  async runOnce(): Promise<void> {
    const projects = (await this.service.store.read()).projects;
    for (const item of projects) {
      if (this.stopping) break;
      await this.service.store.withProjectLock(item.id, async () => {
        const current = (await this.service.store.read()).projects.find(p => p.id === item.id);
        if (!current) return;
        if (!current.enabled) {
          await this.service.store.recordWorker({ workerId: this.workerId, projectId: item.id, revision: current.active?.revision ?? 0,
            connectionRevision: 0, state: "paused", updatedAt: new Date().toISOString() });
          return;
        }
        if (await this.hasAbandonedExecution(item.id)) {
          await this.service.store.recordWorker({ workerId: this.workerId, projectId: item.id, revision: current.active?.revision ?? 0,
            connectionRevision: 0, state: "error", message: "Checkout занят или требует восстановления оператором.", updatedAt: new Date().toISOString() });
          return;
        }
        await this.service.applyPending(item.id, this.checkExecutor);
        const snapshot = await this.service.executionSnapshot(item.id);
        if (!snapshot) return;
        const state = { workerId: this.workerId, projectId: item.id, revision: snapshot.active.revision, connectionRevision: snapshot.connection.revision };
        try {
          await this.checkExecutor(this.service.workspace.pathFor(item.id));
          await this.service.store.recordWorker({ ...state, state: "running", updatedAt: new Date().toISOString() });
          await this.execute(snapshot);
          await this.service.store.recordWorker({ ...state, state: "ready", updatedAt: new Date().toISOString() });
        } catch {
          await this.service.store.recordWorker({ ...state, state: "error", message: "Ошибка исполнителя. Проверьте состояние задач и авторизацию Codex.", updatedAt: new Date().toISOString() });
        }
      });
    }
  }
  async runForever(): Promise<void> {
    const stop = () => { this.stopping = true; this.wake?.(); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    try {
      while (!this.stopping) {
        try { await this.runOnce(); } catch { /* Failed registry reads prevent dispatch; retry without logging credentials. */ }
        if (!this.stopping) await new Promise<void>(resolve => {
          const timeout = setTimeout(resolve, this.intervalMs);
          this.wake = () => { clearTimeout(timeout); resolve(); };
        });
      }
    } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); this.wake = undefined; }
  }
}
