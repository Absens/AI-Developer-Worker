import type {
  ExportDigestInput,
  ExternalIssueSnapshot,
  ExternalTransitionInput,
  ImportCandidatesInput,
  LogicalStatus,
  TrackerClient,
  TrackerIssue,
} from "../../models/types.js";
import {
  YANDEX_TRACKER_PROVIDER,
  type YandexBridgeExternalSource,
} from "./types.js";

const LOGICAL_STATUSES = new Set<LogicalStatus>([
  "open",
  "in_progress",
  "waiting_for_answer",
  "review",
  "failed",
  "done",
]);

const isLogicalStatus = (value: string): value is LogicalStatus =>
  LOGICAL_STATUSES.has(value as LogicalStatus);

export class YandexExternalTaskSource implements YandexBridgeExternalSource {
  constructor(
    private readonly tracker: TrackerClient,
    private readonly tag?: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async importCandidates(
    input: ImportCandidatesInput,
  ): Promise<ExternalIssueSnapshot[]> {
    const issues = await this.tracker.findCandidateIssues({
      ...(input.queue ? { queue: input.queue } : {}),
      ...(this.tag ? { tag: this.tag } : {}),
    });
    const limited = input.limit ? issues.slice(0, input.limit) : issues;
    const observedAt = this.now().toISOString();

    return limited.map((issue) => issueToSnapshot(issue, observedAt));
  }

  async exportDigest(input: ExportDigestInput): Promise<void> {
    await this.tracker.addComment(input.externalKey, input.digest);
  }

  async transitionExternal(input: ExternalTransitionInput): Promise<void> {
    if (!isLogicalStatus(input.targetBusinessStatus)) {
      throw new Error(
        `Unsupported Yandex logical status: ${input.targetBusinessStatus}`,
      );
    }

    const current = await this.tracker.getIssue(input.externalKey);
    const currentLogical = this.tracker.determineLogicalStatus(current);
    if (currentLogical === input.targetBusinessStatus) {
      return;
    }

    await this.tracker.transition(input.externalKey, input.targetBusinessStatus);
  }

  async getComments(externalKey: string) {
    return this.tracker.getComments(externalKey);
  }

  async createIssue(input: Parameters<NonNullable<TrackerClient["createIssue"]>>[0]) {
    if (!this.tracker.createIssue) {
      throw new Error("Yandex Tracker issue creation is not supported by this source.");
    }
    return this.tracker.createIssue(input);
  }

  async linkIssue(input: Parameters<NonNullable<TrackerClient["linkIssue"]>>[0]) {
    if (!this.tracker.linkIssue) {
      return;
    }
    await this.tracker.linkIssue(input);
  }
}

export const issueToSnapshot = (
  issue: TrackerIssue,
  observedAt: string,
): ExternalIssueSnapshot => ({
  provider: YANDEX_TRACKER_PROVIDER,
  externalKey: issue.key,
  externalUrl: `https://tracker.yandex.ru/${issue.key}`,
  title: issue.title,
  description: issue.description,
  ...(issue.logicalStatus ? { businessStatus: issue.logicalStatus } : {}),
  ...(issue.queue ? { queue: issue.queue } : {}),
  ...(issue.tags ? { tags: [...issue.tags] } : {}),
  ...(issue.components ? { components: [...issue.components] } : {}),
  ...(issue.priority ? { priority: issue.priority } : {}),
  ...(issue.deadline ? { deadline: issue.deadline } : {}),
  payload: {
    issue: structuredClone(issue) as unknown as Record<string, unknown>,
  },
  ...(issue.updatedAt ? { sourceUpdatedAt: issue.updatedAt } : {}),
  observedAt,
});
