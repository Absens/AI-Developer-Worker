import { SettingsError, type AppliedWorkerState, type SettingsDocument, type SettingsStore } from "./types.js";

export const emptySettings = (): SettingsDocument => ({ revision: 0, connections: [], projects: [] });

/** Test adapter. Production managed mode always uses PostgreSQL. */
export class MemorySettingsStore implements SettingsStore {
  private data = emptySettings();
  private locks = new Set<string>();
  private applied = new Map<string, AppliedWorkerState>();
  readonly audit: { revision: number; actor: string; action: string }[] = [];
  async read(): Promise<SettingsDocument> { return structuredClone(this.data); }
  async change(expected: number | undefined, actor: string, action: string,
    mutate: (document: SettingsDocument) => void): Promise<SettingsDocument> {
    if (expected !== undefined && expected !== this.data.revision) throw new SettingsError(409, "Настройки изменились. Обновите страницу и повторите изменение.");
    const next = structuredClone(this.data);
    mutate(next);
    next.revision++;
    this.data = next;
    this.audit.push({ revision: next.revision, actor, action });
    return this.read();
  }
  async withProjectLock<T>(id: string, run: () => Promise<T>): Promise<{ acquired: boolean; result?: T }> {
    if (this.locks.has(id)) return { acquired: false };
    this.locks.add(id);
    try { return { acquired: true, result: await run() }; } finally { this.locks.delete(id); }
  }
  async recordWorker(value: AppliedWorkerState): Promise<void> { this.applied.set(`${value.workerId}:${value.projectId}`, structuredClone(value)); }
  async workers(): Promise<AppliedWorkerState[]> { return [...this.applied.values()].map(value => structuredClone(value)); }
}
