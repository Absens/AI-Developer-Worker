import { createHash } from "node:crypto";

import type {
  CommentWithMetadata,
  ExternalIssueSnapshot,
  HumanTaskCommand,
  TaskActor,
  TaskComment,
  TaskRecord,
  TaskStatus,
  TaskTrackerClient,
} from "../../models/types.js";
import { mapTaskStatusToLogicalStatus } from "../../domain/taskTracker/index.js";
import {
  formatDigestComment,
  parseHumanTaskCommand,
} from "../tracker/commentProtocol.js";
import { redactSecrets } from "../../observability/redaction.js";
import { Logger } from "../../utils/logger.js";
import {
  YANDEX_TRACKER_PROVIDER,
  type YandexBridgeExternalSource,
  type YandexBridgeRepositoryBinding,
  type YandexBridgeStore,
} from "./types.js";

export interface YandexBridgeImportResult {
  created: number;
  updated: number;
  commentsImported: number;
}

export interface YandexBridgeOptions {
  taskTracker: TaskTrackerClient;
  source: YandexBridgeExternalSource;
  store: YandexBridgeStore;
  repository: YandexBridgeRepositoryBinding;
  workerId: string;
  logger?: Logger;
  now?: () => Date;
}

const ACTIVE_CONTEXT_STATUSES = new Set<TaskStatus>([
  "claimed",
  "analyzing",
  "decomposing",
  "implementing",
  "validating",
  "fixing_review",
  "review",
]);

const EXTERNAL_ACTOR: TaskActor = {
  owner: "external_source",
  id: YANDEX_TRACKER_PROVIDER,
  displayName: "Yandex Tracker",
};

const normalizeArray = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];

const mergeArrays = (
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] => normalizeArray([...(first ?? []), ...(second ?? [])]);

const sameArray = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
};

const deterministicTaskId = (externalKey: string): string =>
  `yt_${externalKey.replace(/[^A-Za-z0-9._-]/g, "_")}`;

const revisionIdFor = (snapshot: ExternalIssueSnapshot): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        title: snapshot.title,
        description: snapshot.description,
        sourceUpdatedAt: snapshot.sourceUpdatedAt,
      }),
    )
    .digest("hex");

const isActiveContextStatus = (status: TaskStatus): boolean =>
  ACTIVE_CONTEXT_STATUSES.has(status);

const isWorkableNewExternalStatus = (status: string | undefined): boolean =>
  status === "open";

const latestQuestion = (comments: readonly TaskComment[]): TaskComment | undefined =>
  [...comments]
    .filter((comment) => comment.kind === "question")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);

const yandexRef = (task: TaskRecord) =>
  task.externalRefs.find((ref) => ref.provider === YANDEX_TRACKER_PROVIDER);

export class YandexBridge {
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(private readonly options: YandexBridgeOptions) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? new Logger();
  }

  async importCandidates(
    input: { targetExternalKey?: string } = {},
  ): Promise<YandexBridgeImportResult> {
    const result: YandexBridgeImportResult = {
      created: 0,
      updated: 0,
      commentsImported: 0,
    };

    for (const queue of this.options.repository.queues) {
      const scope = `issues:${this.options.repository.repositoryName}:${queue}`;
      const cursor = await this.options.store.getCursor(YANDEX_TRACKER_PROVIDER, scope);
      const snapshots = await this.options.source.importCandidates({
        queue,
        ...(cursor ? { since: cursor.cursor } : {}),
        ...(input.targetExternalKey ? { targetExternalKey: input.targetExternalKey } : {}),
      });
      for (const snapshot of snapshots) {
        const imported = await this.importSnapshot(snapshot);
        result.created += imported.created ? 1 : 0;
        result.updated += imported.updated ? 1 : 0;
        result.commentsImported += imported.commentsImported;
      }

      await this.options.store.setCursor({
        provider: YANDEX_TRACKER_PROVIDER,
        scope,
        cursor:
          snapshots
            .map((snapshot) => snapshot.sourceUpdatedAt ?? snapshot.observedAt)
            .sort()
            .at(-1) ?? cursor?.cursor ?? this.now().toISOString(),
        updatedAt: this.now().toISOString(),
        payload: {
          importedCount: snapshots.length,
          repositoryName: this.options.repository.repositoryName,
          queue,
        },
      });
    }

    if (result.created > 0 || result.updated > 0 || result.commentsImported > 0) {
      this.logger.info("Yandex bridge import completed.", result);
    }

    return result;
  }

  async exportTaskDigests(taskId: string): Promise<void> {
    const task = await this.options.taskTracker.getTask(taskId);
    const ref = yandexRef(task);
    if (!ref) {
      return;
    }

    if (
      task.events.some((event) =>
        ["task_claimed", "analysis_started", "implementation_started"].includes(event.kind),
      )
    ) {
      await this.exportDigestOnce(task, ref.externalKey, "task_started", {
        details: `Started internal task ${task.id}.`,
      });
    }

    for (const question of task.comments.filter((comment) => comment.kind === "question")) {
      await this.exportDigestOnce(task, ref.externalKey, `question:${question.id}`, {
        digestKind: "ai_question",
        details: question.body ?? "AI requested clarification.",
        payload: question.payload,
      });
    }

    for (const mergeRequest of task.mergeRequests) {
      await this.exportDigestOnce(task, ref.externalKey, `mr_ready:${mergeRequest.id}`, {
        digestKind: "mr_ready",
        details: `Merge Request ready: ${mergeRequest.mergeRequest.url}`,
        payload: {
          branch: mergeRequest.branch,
          mergeRequest: mergeRequest.mergeRequest,
        },
      });
    }

    for (const decomposition of task.decompositionDecisions) {
      await this.exportDigestOnce(task, ref.externalKey, `decomposition:${decomposition.id}`, {
        digestKind: "decomposition_summary",
        details: decomposition.plan.summary,
        payload: {
          childTaskCount: decomposition.plan.subtasks.length,
          risks: decomposition.plan.risks,
        },
      });
    }

    if (task.status === "failed") {
      const failure = [...task.events]
        .reverse()
        .find((event) => event.kind === "task_status_changed" || event.kind === "task_failed");
      await this.exportDigestOnce(task, ref.externalKey, `failed:${failure?.id ?? task.updatedAt}`, {
        digestKind: "failed",
        details: failure?.message ?? "Internal task failed.",
        payload: failure?.payload,
      });
    }

    if (task.status === "done") {
      const completion = [...task.events].reverse().find(
        (event) =>
          event.kind === "task_completed" ||
          (event.kind === "task_status_changed" &&
            (event.payload as { to?: unknown } | undefined)?.to === "done"),
      );
      await this.exportDigestOnce(
        task,
        ref.externalKey,
        `done:${completion?.id ?? task.updatedAt}`,
        {
          digestKind: "done",
          details: completion?.message ?? `Internal task ${task.id} is done.`,
          ...(completion?.payload ? { payload: completion.payload } : {}),
        },
      );
    }
  }

  async syncTaskStatus(taskId: string): Promise<void> {
    const task = await this.options.taskTracker.getTask(taskId);
    const ref = yandexRef(task);
    if (!ref || task.status === "new" || task.status === "triage" || task.status === "ready") {
      return;
    }

    const targetBusinessStatus = mapTaskStatusToLogicalStatus(task.status);
    const last = await this.options.store.getLastStatusSync(
      YANDEX_TRACKER_PROVIDER,
      ref.externalKey,
    );
    if (last?.targetBusinessStatus === targetBusinessStatus) {
      return;
    }

    const reason = `Internal task ${task.id} moved to ${task.status}.`;
    await this.options.source.transitionExternal({
      taskId: task.id,
      provider: YANDEX_TRACKER_PROVIDER,
      externalKey: ref.externalKey,
      targetBusinessStatus,
      reason,
    });
    const syncedAt = this.now().toISOString();
    await this.options.store.recordStatusSync({
      taskId: task.id,
      provider: YANDEX_TRACKER_PROVIDER,
      externalKey: ref.externalKey,
      targetBusinessStatus,
      reason,
      syncedAt,
    });
    await this.options.taskTracker.appendEvent(task.id, {
      kind: "external_status_synced",
      source: "external_source",
      actor: EXTERNAL_ACTOR,
      message: reason,
      payload: {
        provider: YANDEX_TRACKER_PROVIDER,
        externalKey: ref.externalKey,
        targetBusinessStatus,
      },
      createdAt: syncedAt,
    });
  }

  async mirrorApprovedChildTasks(parentTaskId: string): Promise<number> {
    const parent = await this.options.taskTracker.getTask(parentTaskId);
    const parentRef = yandexRef(parent);
    if (!parentRef || !this.isChildMirroringApproved(parent)) {
      return 0;
    }
    if (!this.options.source.createIssue) {
      throw new Error("Yandex child task mirroring requires createIssue support.");
    }

    const childIds = parent.dependencies
      .filter(
        (dependency) =>
          dependency.kind === "parent_child" &&
          dependency.fromTaskId === parent.id &&
          dependency.status === "active",
      )
      .map((dependency) => dependency.toTaskId);
    let mirrored = 0;

    for (const childId of childIds) {
      const child = await this.options.taskTracker.getTask(childId);
      if (yandexRef(child)) {
        continue;
      }

      const created = await this.options.source.createIssue({
        queue: child.queue ?? parent.queue ?? this.options.repository.queues[0] ?? "TASKS",
        title: child.title,
        description: child.description,
        tags: child.tags,
      });
      await this.options.taskTracker.attachExternalRef(child.id, {
        provider: YANDEX_TRACKER_PROVIDER,
        externalKey: created.key,
        externalUrl: `https://tracker.yandex.ru/${created.key}`,
        businessStatus: created.logicalStatus,
        lastSeenAt: this.now().toISOString(),
      });
      if (this.options.source.linkIssue) {
        await this.options.source.linkIssue({
          sourceIssueKey: parentRef.externalKey,
          targetIssueKey: created.key,
          linkType: "relates",
        });
      }
      mirrored += 1;
    }

    return mirrored;
  }

  private async importSnapshot(snapshot: ExternalIssueSnapshot): Promise<{
    created: boolean;
    updated: boolean;
    commentsImported: number;
  }> {
    if (snapshot.provider !== YANDEX_TRACKER_PROVIDER) {
      throw new Error(`Unsupported external provider: ${snapshot.provider}`);
    }

    const existing = await this.options.taskTracker.findTaskByExternalRef(
      snapshot.provider,
      snapshot.externalKey,
    );
    if (!existing && !isWorkableNewExternalStatus(snapshot.businessStatus)) {
      this.logger.info("Skipping non-open Yandex issue during import.", {
        externalKey: snapshot.externalKey,
        businessStatus: snapshot.businessStatus ?? "unknown",
      });
      return {
        created: false,
        updated: false,
        commentsImported: 0,
      };
    }

    const task = existing ?? (await this.createTaskFromSnapshot(snapshot));
    const externalRevisionId = revisionIdFor(snapshot);
    const storedAt = this.now().toISOString();
    await this.options.store.recordIssueSnapshot({
      taskId: task.id,
      snapshot,
      externalRevisionId,
      storedAt,
    });
    await this.options.store.recordFieldOwnership({
      provider: snapshot.provider,
      externalKey: snapshot.externalKey,
      taskId: task.id,
      owner: "external_source",
      fields: [
        "title",
        "description",
        "priority",
        "deadline",
        "tags",
        "components",
        "queue",
        "businessStatus",
      ],
      updatedAt: storedAt,
    });

    const updatedTask = existing
      ? await this.applySnapshotUpdates(existing, snapshot, externalRevisionId)
      : task;
    const commentsImported = await this.importComments(updatedTask);

    return {
      created: existing === null,
      updated: existing !== null && updatedTask.updatedAt !== existing.updatedAt,
      commentsImported,
    };
  }

  private async createTaskFromSnapshot(
    snapshot: ExternalIssueSnapshot,
  ): Promise<TaskRecord> {
    const tags = mergeArrays(snapshot.tags, this.options.repository.tags);
    return this.options.taskTracker.createTask({
      id: deterministicTaskId(snapshot.externalKey),
      title: snapshot.title,
      description: snapshot.description,
      source: {
        kind: "external",
        provider: snapshot.provider,
        externalKey: snapshot.externalKey,
      },
      createdBy: EXTERNAL_ACTOR,
      repositoryName: this.options.repository.repositoryName,
      repoPathKey: this.options.repository.repoPathKey,
      baseBranch: this.options.repository.baseBranch,
      queue: snapshot.queue ?? this.options.repository.queues[0],
      tags,
      components: snapshot.components ?? [],
      priority: snapshot.priority,
      deadline: snapshot.deadline,
      status: "ready",
      businessStatus: snapshot.businessStatus,
      taskType: "unknown",
      acceptanceCriteria: [],
      externalRefs: [
        {
          provider: snapshot.provider,
          externalKey: snapshot.externalKey,
          ...(snapshot.externalUrl ? { externalUrl: snapshot.externalUrl } : {}),
          ...(snapshot.businessStatus ? { businessStatus: snapshot.businessStatus } : {}),
          lastSeenAt: snapshot.observedAt,
        },
      ],
      externalSnapshot: snapshot.payload,
      externalRevisionId: revisionIdFor(snapshot),
      lastSyncedAt: snapshot.observedAt,
    });
  }

  private async applySnapshotUpdates(
    task: TaskRecord,
    snapshot: ExternalIssueSnapshot,
    externalRevisionId: string,
  ): Promise<TaskRecord> {
    let updated = task;
    const humanInputChanged =
      task.title !== snapshot.title || task.description !== snapshot.description;
    const requiresReanalysis = humanInputChanged && isActiveContextStatus(task.status);

    if (humanInputChanged) {
      updated = await this.options.taskTracker.updateTaskRevision(task.id, {
        owner: "external_source",
        author: EXTERNAL_ACTOR,
        title: snapshot.title,
        description: snapshot.description,
        externalSnapshot: snapshot.payload,
        externalRevisionId,
        requiresReanalysis,
        reason: "Yandex issue human input changed.",
      });
      if (requiresReanalysis) {
        await this.recordContextChanged(updated, {
          externalKey: snapshot.externalKey,
          changedFields: [
            ...(task.title !== snapshot.title ? ["title"] : []),
            ...(task.description !== snapshot.description ? ["description"] : []),
          ],
          externalRevisionId,
        });
      }
    }

    const tags = snapshot.tags ? mergeArrays(snapshot.tags, this.options.repository.tags) : task.tags;
    const components = snapshot.components ?? task.components;
    const derivedChanged =
      (snapshot.queue !== undefined && snapshot.queue !== task.queue) ||
      !sameArray(tags, task.tags) ||
      !sameArray(components, task.components) ||
      (snapshot.priority ?? undefined) !== task.priority ||
      (snapshot.deadline ?? undefined) !== task.deadline ||
      (snapshot.businessStatus ?? undefined) !== task.businessStatus;

    if (derivedChanged) {
      updated = await this.options.taskTracker.updateExternalTaskFields(task.id, {
        owner: "external_source",
        author: EXTERNAL_ACTOR,
        ...(snapshot.queue !== undefined ? { queue: snapshot.queue } : {}),
        tags,
        components,
        ...(snapshot.priority !== undefined ? { priority: snapshot.priority } : {}),
        ...(snapshot.deadline !== undefined ? { deadline: snapshot.deadline } : {}),
        ...(snapshot.businessStatus !== undefined
          ? { businessStatus: snapshot.businessStatus }
          : {}),
        externalRef: {
          provider: snapshot.provider,
          externalKey: snapshot.externalKey,
          ...(snapshot.businessStatus !== undefined
            ? { businessStatus: snapshot.businessStatus }
            : {}),
          lastSeenAt: snapshot.observedAt,
        },
        lastSyncedAt: snapshot.observedAt,
        reason: "Yandex issue business fields changed.",
      });
    }

    return updated;
  }

  private async importComments(task: TaskRecord): Promise<number> {
    const ref = yandexRef(task);
    if (!ref) {
      return 0;
    }

    const comments = await this.options.source.getComments(ref.externalKey);
    let imported = 0;
    for (const comment of comments) {
      if (comment.metadata || comment.isSystem) {
        continue;
      }
      if (
        await this.options.store.hasImportedComment(
          YANDEX_TRACKER_PROVIDER,
          ref.externalKey,
          comment.id,
        )
      ) {
        continue;
      }

      const author = this.commentAuthor(comment);
      const command = parseHumanTaskCommand(comment.text);
      const question = latestQuestion(task.comments);
      const isAnswer =
        command !== undefined ||
        (question !== undefined && comment.createdAt > question.createdAt);

      if (isAnswer) {
        await this.options.taskTracker.recordHumanAnswer(task.id, {
          ...(question ? { questionId: question.id } : {}),
          author,
          body: comment.text,
          ...(command ? { command } : {}),
        });
      } else {
        await this.options.taskTracker.appendComment(task.id, {
          kind: "comment",
          author,
          body: comment.text,
          externalRef: {
            provider: YANDEX_TRACKER_PROVIDER,
            externalKey: comment.id,
          },
          createdAt: comment.createdAt,
        });
      }

      await this.options.store.recordImportedComment({
        provider: YANDEX_TRACKER_PROVIDER,
        externalKey: ref.externalKey,
        externalCommentId: comment.id,
        taskId: task.id,
        author,
        body: comment.text,
        ...(command ? { command } : {}),
        importedAt: this.now().toISOString(),
      });
      if (isActiveContextStatus(task.status)) {
        await this.recordContextChanged(task, {
          externalKey: ref.externalKey,
          externalCommentId: comment.id,
          command,
        });
      }
      imported += 1;
    }

    return imported;
  }

  private async exportDigestOnce(
    task: TaskRecord,
    externalKey: string,
    digestKey: string,
    input: {
      digestKind?: string;
      details: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (
      await this.options.store.hasExportedDigest(
        YANDEX_TRACKER_PROVIDER,
        externalKey,
        digestKey,
      )
    ) {
      return;
    }

    const digestInput = redactSecrets({
      taskId: task.id,
      digestKind: input.digestKind ?? digestKey,
      externalKey,
      details: input.details,
      ...(input.payload ? { payload: input.payload } : {}),
    });
    const digest = formatDigestComment(this.options.workerId, digestInput);
    await this.options.source.exportDigest({
      taskId: task.id,
      provider: YANDEX_TRACKER_PROVIDER,
      externalKey,
      digest,
      ...(digestInput.payload ? { payload: digestInput.payload } : {}),
    });
    await this.options.store.recordExportedDigest({
      taskId: task.id,
      provider: YANDEX_TRACKER_PROVIDER,
      externalKey,
      digestKey,
      digest,
      ...(digestInput.payload ? { payload: digestInput.payload } : {}),
      exportedAt: this.now().toISOString(),
    });
  }

  private async recordContextChanged(
    task: TaskRecord,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.options.taskTracker.appendEvent(task.id, {
      kind: "context_changed",
      source: "external_source",
      actor: EXTERNAL_ACTOR,
      message: "External human input changed during active work.",
      payload: {
        provider: YANDEX_TRACKER_PROVIDER,
        requiresReanalysis: true,
        ...payload,
      },
      createdAt: this.now().toISOString(),
    });
  }

  private commentAuthor(comment: CommentWithMetadata): TaskActor {
    const displayName = comment.author?.trim();
    return {
      owner: "human",
      id: displayName ? `yandex:${displayName}` : `yandex-comment:${comment.id}`,
      ...(displayName ? { displayName } : {}),
    };
  }

  private isChildMirroringApproved(task: TaskRecord): boolean {
    if (this.options.repository.childMirroringEnabled) {
      return true;
    }

    return task.decisions.some((decision) => {
      const bridge = decision.payload.yandexBridge;
      return (
        typeof bridge === "object" &&
        bridge !== null &&
        (bridge as { approveChildMirroring?: unknown }).approveChildMirroring === true
      );
    });
  }
}

export type { HumanTaskCommand };
