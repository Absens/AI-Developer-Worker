import type { Pool } from "pg";
import { SettingsError, type AppliedWorkerState, type SettingsDocument, type SettingsStore } from "../../domain/settings/types.js";

export class PostgresSettingsStore implements SettingsStore {
  constructor(private readonly pool: Pool) {}
  async read(): Promise<SettingsDocument> {
    const result = await this.pool.query("SELECT document FROM managed_settings WHERE id = 1");
    if (!result.rows[0]) throw new Error("Managed settings schema is not initialized. Run tracker:migrate.");
    return result.rows[0].document as SettingsDocument;
  }
  async change(expected: number | undefined, actor: string, action: string,
    mutate: (document: SettingsDocument) => void): Promise<SettingsDocument> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT document FROM managed_settings WHERE id = 1 FOR UPDATE");
      const data = result.rows[0]?.document as SettingsDocument | undefined;
      if (!data) throw new Error("Managed settings schema missing.");
      if (expected !== undefined && expected !== data.revision) throw new SettingsError(409, "Настройки изменились. Обновите страницу и повторите изменение.");
      mutate(data); data.revision++;
      await client.query("UPDATE managed_settings SET revision=$1, document=$2::jsonb, updated_at=now() WHERE id=1", [data.revision, JSON.stringify(data)]);
      await client.query("INSERT INTO managed_settings_audit(revision,actor,action) VALUES($1,$2,$3)", [data.revision, actor, action]);
      await client.query("COMMIT");
      return data;
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally { client.release(); }
  }
  async withProjectLock<T>(id: string, run: () => Promise<T>): Promise<{ acquired: boolean; result?: T }> {
    const client = await this.pool.connect();
    let acquired = false;
    try {
      const result = await client.query("SELECT pg_try_advisory_lock(128734, hashtext($1)) AS acquired", [id]);
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) return { acquired: false };
      return { acquired: true, result: await run() };
    } finally {
      let discard = false;
      if (acquired) {
        try { await client.query("SELECT pg_advisory_unlock(128734, hashtext($1))", [id]); }
        catch { discard = true; }
      }
      client.release(discard);
    }
  }
  async recordWorker(value: AppliedWorkerState): Promise<void> {
    await this.pool.query(`INSERT INTO managed_worker_settings(worker_id,project_id,revision,connection_revision,state,message,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(worker_id,project_id) DO UPDATE SET
      revision=EXCLUDED.revision,connection_revision=EXCLUDED.connection_revision,state=EXCLUDED.state,message=EXCLUDED.message,updated_at=EXCLUDED.updated_at`,
      [value.workerId, value.projectId, value.revision, value.connectionRevision, value.state, value.message ?? null, value.updatedAt]);
  }
  async workers(): Promise<AppliedWorkerState[]> {
    const result = await this.pool.query(`SELECT worker_id AS "workerId",project_id AS "projectId",revision,
      connection_revision AS "connectionRevision",state,message,updated_at AS "updatedAt" FROM managed_worker_settings ORDER BY worker_id,project_id`);
    return result.rows.map(row => ({ ...row, revision: Number(row.revision), connectionRevision: Number(row.connectionRevision), updatedAt: new Date(row.updatedAt).toISOString() })) as AppliedWorkerState[];
  }
}
