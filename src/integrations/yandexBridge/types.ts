import type {
  CommentWithMetadata,
  CreateTrackerIssueInput,
  ExternalFieldOwnership,
  ExternalIssueSnapshot,
  ExternalTaskSource,
  ImportedHumanCommand,
  LinkTrackerIssueInput,
  SyncCursor,
  TrackerComment,
  TrackerIssue,
} from "../../models/types.js";

export const YANDEX_TRACKER_PROVIDER = "yandex_tracker";

export interface YandexBridgeExternalSource extends ExternalTaskSource {
  getComments(externalKey: string): Promise<CommentWithMetadata[]>;
  createIssue?(input: CreateTrackerIssueInput): Promise<TrackerIssue>;
  linkIssue?(input: LinkTrackerIssueInput): Promise<void>;
}

export interface ExternalIssueSnapshotRecord {
  taskId: string;
  snapshot: ExternalIssueSnapshot;
  externalRevisionId?: string;
  storedAt: string;
}

export interface DigestExportRecord {
  taskId: string;
  provider: string;
  externalKey: string;
  digestKey: string;
  digest: string;
  payload?: Record<string, unknown>;
  exportedAt: string;
}

export interface ExternalStatusSyncRecord {
  taskId: string;
  provider: string;
  externalKey: string;
  targetBusinessStatus: string;
  reason?: string;
  syncedAt: string;
}

export interface YandexBridgeStore {
  getCursor(provider: string, scope: string): Promise<SyncCursor | null>;
  setCursor(cursor: SyncCursor): Promise<void>;
  recordIssueSnapshot(record: ExternalIssueSnapshotRecord): Promise<void>;
  recordFieldOwnership(ownership: ExternalFieldOwnership): Promise<void>;
  hasImportedComment(
    provider: string,
    externalKey: string,
    externalCommentId: string,
  ): Promise<boolean>;
  recordImportedComment(command: ImportedHumanCommand): Promise<void>;
  hasExportedDigest(
    provider: string,
    externalKey: string,
    digestKey: string,
  ): Promise<boolean>;
  recordExportedDigest(record: DigestExportRecord): Promise<void>;
  getLastStatusSync(
    provider: string,
    externalKey: string,
  ): Promise<ExternalStatusSyncRecord | null>;
  recordStatusSync(record: ExternalStatusSyncRecord): Promise<void>;
}

export interface YandexBridgeRepositoryBinding {
  repositoryName: string;
  repoPathKey: string;
  baseBranch: string;
  queues: string[];
  tags: string[];
  childMirroringEnabled?: boolean;
}

export interface YandexIssuePayload {
  issue: TrackerIssue;
  rawComments?: TrackerComment[];
}
