import type {
  CommentWithMetadata,
  CreateTrackerIssueInput,
  LinkTrackerIssueInput,
  LogicalStatus,
  TrackerClient,
  TrackerIssue,
  TrackerIssueLink,
} from "../../models/types.js";
import { ConfigurationError } from "../../utils/errors.js";
import type { TaskTrackerClient } from "../../domain/taskTracker/index.js";

const unsupportedInternalRuntimeMessage =
  "TASK_TRACKER_PROVIDER=internal is configured, but Yandex-style TrackerClient runtime calls are disabled. Use the internal worker workflow boundary or set TASK_TRACKER_PROVIDER=yandex for direct Tracker mode.";

export class InternalTrackerRuntimeGuardClient implements TrackerClient {
  constructor(private readonly taskTracker: TaskTrackerClient | undefined) {}

  async checkReadAccess(): Promise<void> {
    this.ensureInternalTrackerConfigured();
  }

  async findCandidateIssues(): Promise<TrackerIssue[]> {
    return this.failUnsupportedRuntime();
  }

  async findOwnedIssues(): Promise<TrackerIssue[]> {
    return this.failUnsupportedRuntime();
  }

  async getIssue(): Promise<TrackerIssue> {
    return this.failUnsupportedRuntime();
  }

  async getComments(): Promise<CommentWithMetadata[]> {
    return this.failUnsupportedRuntime();
  }

  async addComment(): Promise<void> {
    return this.failUnsupportedRuntime();
  }

  async transition(): Promise<void> {
    return this.failUnsupportedRuntime();
  }

  determineLogicalStatus(issue: TrackerIssue): LogicalStatus | undefined {
    return issue.logicalStatus;
  }

  async createIssue(_input: CreateTrackerIssueInput): Promise<TrackerIssue> {
    return this.failUnsupportedRuntime();
  }

  async linkIssue(_input: LinkTrackerIssueInput): Promise<void> {
    return this.failUnsupportedRuntime();
  }

  async getIssueLinks(): Promise<TrackerIssueLink[]> {
    return this.failUnsupportedRuntime();
  }

  private ensureInternalTrackerConfigured(): void {
    if (!this.taskTracker) {
      throw new ConfigurationError(
        "TASK_TRACKER_PROVIDER=internal requires an internal task tracker client.",
      );
    }
  }

  private failUnsupportedRuntime(): never {
    this.ensureInternalTrackerConfigured();
    throw new ConfigurationError(unsupportedInternalRuntimeMessage);
  }
}
