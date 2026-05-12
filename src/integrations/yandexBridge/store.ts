import { randomUUID } from "node:crypto";

import type {
  ExternalFieldOwnership,
  ImportedHumanCommand,
  SyncCursor,
} from "../../models/types.js";
import type { PostgresQueryable } from "../internalTracker/postgresTaskTracker.js";
import type {
  DigestExportRecord,
  ExternalIssueSnapshotRecord,
  ExternalStatusSyncRecord,
  YandexBridgeStore,
} from "./types.js";

const normalizeRef = (provider: string, externalKey: string): string =>
  `${provider.trim().toLowerCase()}:${externalKey.trim().toLowerCase()}`;

const cursorKey = (provider: string, scope: string): string =>
  `${provider.trim().toLowerCase()}:${scope.trim().toLowerCase()}`;

const digestKey = (
  provider: string,
  externalKey: string,
  key: string,
): string => `${normalizeRef(provider, externalKey)}:${key}`;

export class InMemoryYandexBridgeStore implements YandexBridgeStore {
  private readonly cursors = new Map<string, SyncCursor>();
  private readonly snapshots: ExternalIssueSnapshotRecord[] = [];
  private readonly ownership = new Map<string, ExternalFieldOwnership>();
  private readonly importedComments = new Map<string, ImportedHumanCommand>();
  private readonly exportedDigests = new Map<string, DigestExportRecord>();
  private readonly statusSyncs = new Map<string, ExternalStatusSyncRecord>();

  async getCursor(provider: string, scope: string): Promise<SyncCursor | null> {
    return structuredClone(this.cursors.get(cursorKey(provider, scope)) ?? null);
  }

  async setCursor(cursor: SyncCursor): Promise<void> {
    this.cursors.set(cursorKey(cursor.provider, cursor.scope), structuredClone(cursor));
  }

  async recordIssueSnapshot(record: ExternalIssueSnapshotRecord): Promise<void> {
    this.snapshots.push(structuredClone(record));
  }

  async recordFieldOwnership(ownership: ExternalFieldOwnership): Promise<void> {
    this.ownership.set(
      normalizeRef(ownership.provider, ownership.externalKey),
      structuredClone(ownership),
    );
  }

  async hasImportedComment(
    provider: string,
    externalKey: string,
    externalCommentId: string,
  ): Promise<boolean> {
    return this.importedComments.has(
      digestKey(provider, externalKey, externalCommentId),
    );
  }

  async recordImportedComment(command: ImportedHumanCommand): Promise<void> {
    this.importedComments.set(
      digestKey(command.provider, command.externalKey, command.externalCommentId),
      structuredClone(command),
    );
  }

  async hasExportedDigest(
    provider: string,
    externalKey: string,
    key: string,
  ): Promise<boolean> {
    return this.exportedDigests.has(digestKey(provider, externalKey, key));
  }

  async recordExportedDigest(record: DigestExportRecord): Promise<void> {
    this.exportedDigests.set(
      digestKey(record.provider, record.externalKey, record.digestKey),
      structuredClone(record),
    );
  }

  async getLastStatusSync(
    provider: string,
    externalKey: string,
  ): Promise<ExternalStatusSyncRecord | null> {
    return structuredClone(this.statusSyncs.get(normalizeRef(provider, externalKey)) ?? null);
  }

  async recordStatusSync(record: ExternalStatusSyncRecord): Promise<void> {
    this.statusSyncs.set(
      normalizeRef(record.provider, record.externalKey),
      structuredClone(record),
    );
  }
}

export class PostgresYandexBridgeStore implements YandexBridgeStore {
  constructor(private readonly db: PostgresQueryable) {}

  async getCursor(provider: string, scope: string): Promise<SyncCursor | null> {
    const result = await this.db.query(
      `
        SELECT provider, scope, cursor, payload, updated_at
        FROM sync_cursors
        WHERE lower(provider) = lower($1) AND lower(scope) = lower($2)
        LIMIT 1
      `,
      [provider, scope],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      provider: String(row.provider),
      scope: String(row.scope),
      cursor: String(row.cursor),
      updatedAt: toIso(row.updated_at),
      ...(row.payload ? { payload: row.payload as Record<string, unknown> } : {}),
    };
  }

  async setCursor(cursor: SyncCursor): Promise<void> {
    await this.db.query(
      `
        INSERT INTO sync_cursors (provider, scope, cursor, payload, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (provider, scope)
        DO UPDATE SET cursor = EXCLUDED.cursor,
                      payload = EXCLUDED.payload,
                      updated_at = EXCLUDED.updated_at
      `,
      [
        cursor.provider,
        cursor.scope,
        cursor.cursor,
        cursor.payload ? JSON.stringify(cursor.payload) : null,
        cursor.updatedAt,
      ],
    );
  }

  async recordIssueSnapshot(record: ExternalIssueSnapshotRecord): Promise<void> {
    await this.db.query(
      `
        INSERT INTO external_issue_snapshots (
          id, task_id, provider, external_key, external_revision_id,
          payload, observed_at, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      `,
      [
        `snapshot_${randomUUID()}`,
        record.taskId,
        record.snapshot.provider,
        record.snapshot.externalKey,
        record.externalRevisionId ?? null,
        JSON.stringify(record.snapshot.payload),
        record.snapshot.observedAt,
        record.storedAt,
      ],
    );
  }

  async recordFieldOwnership(ownership: ExternalFieldOwnership): Promise<void> {
    await this.db.query(
      `
        INSERT INTO external_field_ownership (
          task_id, provider, external_key, owner, fields, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (task_id, provider, external_key)
        DO UPDATE SET owner = EXCLUDED.owner,
                      fields = EXCLUDED.fields,
                      updated_at = EXCLUDED.updated_at
      `,
      [
        ownership.taskId,
        ownership.provider,
        ownership.externalKey,
        ownership.owner,
        ownership.fields,
        ownership.updatedAt,
      ],
    );
  }

  async hasImportedComment(
    provider: string,
    externalKey: string,
    externalCommentId: string,
  ): Promise<boolean> {
    const result = await this.db.query(
      `
        SELECT 1
        FROM imported_human_commands
        WHERE lower(provider) = lower($1)
          AND lower(external_key) = lower($2)
          AND external_comment_id = $3
        LIMIT 1
      `,
      [provider, externalKey, externalCommentId],
    );
    return Boolean(result.rowCount && result.rowCount > 0);
  }

  async recordImportedComment(command: ImportedHumanCommand): Promise<void> {
    await this.db.query(
      `
        INSERT INTO imported_human_commands (
          id, task_id, provider, external_key, external_comment_id,
          author, body, command, imported_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9)
        ON CONFLICT (provider, external_key, external_comment_id) DO NOTHING
      `,
      [
        `import_${randomUUID()}`,
        command.taskId,
        command.provider,
        command.externalKey,
        command.externalCommentId,
        command.author ? JSON.stringify(command.author) : null,
        command.body,
        command.command ? JSON.stringify(command.command) : null,
        command.importedAt,
      ],
    );
  }

  async hasExportedDigest(
    provider: string,
    externalKey: string,
    key: string,
  ): Promise<boolean> {
    const result = await this.db.query(
      `
        SELECT 1
        FROM external_digest_exports
        WHERE lower(provider) = lower($1)
          AND lower(external_key) = lower($2)
          AND digest_key = $3
        LIMIT 1
      `,
      [provider, externalKey, key],
    );
    return Boolean(result.rowCount && result.rowCount > 0);
  }

  async recordExportedDigest(record: DigestExportRecord): Promise<void> {
    await this.db.query(
      `
        INSERT INTO external_digest_exports (
          id, task_id, provider, external_key, digest_key, digest, payload,
          exported_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
        ON CONFLICT (provider, external_key, digest_key) DO NOTHING
      `,
      [
        `digest_${randomUUID()}`,
        record.taskId,
        record.provider,
        record.externalKey,
        record.digestKey,
        record.digest,
        record.payload ? JSON.stringify(record.payload) : null,
        record.exportedAt,
      ],
    );
  }

  async getLastStatusSync(
    provider: string,
    externalKey: string,
  ): Promise<ExternalStatusSyncRecord | null> {
    const result = await this.db.query(
      `
        SELECT task_id, provider, external_key, target_business_status,
               reason, synced_at
        FROM external_status_syncs
        WHERE lower(provider) = lower($1) AND lower(external_key) = lower($2)
        ORDER BY synced_at DESC, id DESC
        LIMIT 1
      `,
      [provider, externalKey],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      taskId: String(row.task_id),
      provider: String(row.provider),
      externalKey: String(row.external_key),
      targetBusinessStatus: String(row.target_business_status),
      ...(row.reason ? { reason: String(row.reason) } : {}),
      syncedAt: toIso(row.synced_at),
    };
  }

  async recordStatusSync(record: ExternalStatusSyncRecord): Promise<void> {
    await this.db.query(
      `
        INSERT INTO external_status_syncs (
          id, task_id, provider, external_key, target_business_status,
          reason, synced_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (provider, external_key, target_business_status)
        DO UPDATE SET reason = EXCLUDED.reason,
                      synced_at = EXCLUDED.synced_at
      `,
      [
        `sync_${randomUUID()}`,
        record.taskId,
        record.provider,
        record.externalKey,
        record.targetBusinessStatus,
        record.reason ?? null,
        record.syncedAt,
      ],
    );
  }
}

const toIso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
