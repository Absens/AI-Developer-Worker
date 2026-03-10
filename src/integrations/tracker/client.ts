import type {
  AppConfig,
  CommentWithMetadata,
  LogicalStatus,
  TrackerClient,
  TrackerComment,
  TrackerIssue,
} from "../../models/types.js";
import { ConfigurationError, TemporaryIntegrationError } from "../../utils/errors.js";
import { Logger } from "../../utils/logger.js";
import { withRetry } from "../../utils/retry.js";
import { decorateComments } from "./commentProtocol.js";

interface TrackerRequestOptions {
  method?: string;
  query?: Record<string, string | number>;
  body?: unknown;
}

interface TrackerSearchResponseItem {
  id: string;
  key: string;
  summary?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: {
    key?: string;
    display?: string;
  };
}

const normalize = (value?: string): string =>
  value?.trim().toLowerCase() ?? "";

const buildIssue = (
  issue: TrackerSearchResponseItem,
  logicalStatus?: LogicalStatus,
): TrackerIssue => ({
  id: issue.id,
  key: issue.key,
  title: issue.summary?.trim() || issue.key,
  description: issue.description?.trim() || "",
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  statusKey: issue.status?.key,
  statusDisplay: issue.status?.display,
  logicalStatus,
});

export class YandexTrackerClient implements TrackerClient {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  determineLogicalStatus(issue: TrackerIssue): LogicalStatus | undefined {
    const candidates = [
      normalize(issue.statusKey),
      normalize(issue.statusDisplay),
    ];

    for (const [logicalStatus, statusConfig] of Object.entries(
      this.config.trackerStatusMap,
    ) as [LogicalStatus, AppConfig["trackerStatusMap"][LogicalStatus]][]) {
      const normalizedStatuses = statusConfig.statuses.map(normalize);
      if (candidates.some((candidate) => normalizedStatuses.includes(candidate))) {
        return logicalStatus;
      }
    }

    return undefined;
  }

  async findCandidateIssues(): Promise<TrackerIssue[]> {
    const issues = await this.searchIssuesByTag();
    return issues
      .map((issue) => buildIssue(issue, this.determineLogicalStatus(buildIssue(issue))))
      .sort(sortIssues);
  }

  async findOwnedIssues(statuses: LogicalStatus[]): Promise<TrackerIssue[]> {
    const issues = await this.findCandidateIssues();
    return issues.filter(
      (issue) => issue.logicalStatus && statuses.includes(issue.logicalStatus),
    );
  }

  async getIssue(issueKey: string): Promise<TrackerIssue> {
    const issue = await this.request<TrackerSearchResponseItem>(`/issues/${issueKey}`);
    const built = buildIssue(issue);
    return {
      ...built,
      logicalStatus: this.determineLogicalStatus(built),
    };
  }

  async getComments(issueKey: string): Promise<CommentWithMetadata[]> {
    const response = await this.request<
      TrackerComment[] | { values?: TrackerComment[]; comments?: TrackerComment[] }
    >(`/issues/${issueKey}/comments`, {
      query: { perPage: 100 },
    });

    const comments = Array.isArray(response)
      ? response
      : response.values ?? response.comments ?? [];

    return decorateComments(
      comments.map((comment: any) => ({
        id: String(comment.id),
        text: String(comment.text ?? ""),
        createdAt: String(comment.createdAt ?? ""),
        author:
          typeof comment.createdBy?.display === "string"
            ? comment.createdBy.display
            : typeof comment.createdBy?.id === "string"
              ? comment.createdBy.id
              : undefined,
        isSystem: Boolean(comment.summonees || comment.transport || comment.isSystem),
      })),
    );
  }

  async addComment(issueKey: string, text: string): Promise<void> {
    await this.request(`/issues/${issueKey}/comments`, {
      method: "POST",
      body: { text },
    });
  }

  async transition(issueKey: string, targetStatus: LogicalStatus): Promise<void> {
    const transition = this.config.trackerStatusMap[targetStatus].transition;
    if (!transition) {
      throw new ConfigurationError(
        `No transition configured for logical status: ${targetStatus}`,
      );
    }

    await this.request(`/issues/${issueKey}/transitions/${transition}/_execute`, {
      method: "POST",
    });
  }

  private async searchIssuesByTag(): Promise<TrackerSearchResponseItem[]> {
    const result = await this.request<TrackerSearchResponseItem[]>("/issues/_search", {
      method: "POST",
      query: {
        perPage: 100,
      },
      body: {
        query: `tag: "${this.config.trackerTag}"`,
        order: "+createdAt",
      },
    });

    this.logger.info("Fetched tracker candidates.", { count: result.length });
    return result;
  }

  private async request<T>(
    path: string,
    options: TrackerRequestOptions = {},
  ): Promise<T> {
    return withRetry(
      async () => {
        const url = new URL(`${this.config.trackerApiBaseUrl}${path}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
          url.searchParams.set(key, String(value));
        }

        const response = await fetch(url, {
          method: options.method ?? "GET",
          headers: {
            Authorization: `OAuth ${this.config.trackerToken}`,
            "X-Cloud-Org-Id": this.config.trackerOrgId,
            "Content-Type": "application/json",
          },
          body: options.body === undefined ? null : JSON.stringify(options.body),
        }).catch((error) => {
          throw new TemporaryIntegrationError(`Tracker request failed: ${path}`, error);
        });

        if (response.status >= 500) {
          throw new TemporaryIntegrationError(
            `Tracker temporary error ${response.status} for ${path}`,
          );
        }

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Tracker request failed for ${path}: ${response.status} ${body}`);
        }

        if (response.status === 204) {
          return undefined as T;
        }

        return (await response.json()) as T;
      },
      {
        retries: 3,
        delayMs: 500,
        label: `tracker:${path}`,
        logger: this.logger,
      },
    );
  }
}

const sortIssues = (left: TrackerIssue, right: TrackerIssue): number => {
  const leftTimestamp = left.createdAt || left.updatedAt || "";
  const rightTimestamp = right.createdAt || right.updatedAt || "";
  return leftTimestamp.localeCompare(rightTimestamp);
};
