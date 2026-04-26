import type {
  AppConfig,
  CommentWithMetadata,
  CreateTrackerIssueInput,
  LinkTrackerIssueInput,
  LogicalStatus,
  TrackerClient,
  TrackerComment,
  TrackerIssue,
  TrackerIssueLink,
} from "../../models/types.js";
import { ConfigurationError, TemporaryIntegrationError } from "../../utils/errors.js";
import { Logger } from "../../utils/logger.js";
import { withRetry } from "../../utils/retry.js";
import { decorateComments } from "./commentProtocol.js";

const DEFAULT_PAGE_SIZE = 100;

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
  queue?: {
    key?: string;
    display?: string;
  };
  status?: {
    key?: string;
    display?: string;
  };
  priority?: string | {
    key?: string;
    display?: string;
  };
  deadline?: string;
  components?: Array<string | {
    key?: string;
    display?: string;
  }>;
  tags?: string[];
  blockedBy?: Array<string | { key?: string; display?: string }>;
  blocks?: Array<string | { key?: string; display?: string }>;
}

interface TrackerTransitionResponseItem {
  id?: string;
  key?: string;
  display?: string;
  to?: {
    key?: string;
    display?: string;
  };
}

interface TrackerTransition {
  id: string;
  key?: string;
  display?: string;
  toKey?: string;
  toDisplay?: string;
}

interface TrackerCollectionResponse<T> {
  values?: T[];
  comments?: T[];
  transitions?: T[];
  items?: T[];
}

interface TrackerIssueLinkResponseItem {
  id?: string;
  direction?: string;
  type?: string | {
    key?: string;
    display?: string;
    inward?: string;
    outward?: string;
  };
  relationship?: string | {
    key?: string;
    display?: string;
  };
  object?: {
    key?: string;
  };
  issue?: {
    key?: string;
  };
  linkedIssue?: {
    key?: string;
  };
  target?: {
    key?: string;
  };
}

const normalize = (value?: string): string =>
  value?.trim().toLowerCase() ?? "";

const escapeTrackerQueryValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const extractNamedValue = (
  value: string | { key?: string; display?: string } | undefined,
): string | undefined => {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  return value?.key?.trim() || value?.display?.trim() || undefined;
};

const extractNamedValues = (
  values: Array<string | { key?: string; display?: string }> | undefined,
): string[] | undefined => {
  if (!values) {
    return undefined;
  }

  const normalized = values
    .map(extractNamedValue)
    .filter((entry): entry is string => entry !== undefined);
  return normalized.length > 0 ? normalized : undefined;
};

const extractIssueKeys = (
  values: Array<string | { key?: string; display?: string }> | undefined,
): string[] | undefined => extractNamedValues(values);

const buildIssue = (
  issue: TrackerSearchResponseItem,
  logicalStatus?: LogicalStatus,
): TrackerIssue => ({
  id: issue.id,
  key: issue.key,
  title: issue.summary?.trim() || issue.key,
  description: issue.description?.trim() || "",
  queue: issue.queue?.key?.trim() || issue.key.split("-")[0],
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  statusKey: issue.status?.key,
  statusDisplay: issue.status?.display,
  logicalStatus,
  priority: extractNamedValue(issue.priority),
  deadline: issue.deadline?.trim() || undefined,
  components: extractNamedValues(issue.components),
  tags: issue.tags?.map((tag) => tag.trim()).filter(Boolean),
  blockedBy: extractIssueKeys(issue.blockedBy),
  blocks: extractIssueKeys(issue.blocks),
});

const extractLinkType = (link: TrackerIssueLinkResponseItem): string | undefined => {
  const relationship = extractNamedValue(link.relationship);
  if (relationship) {
    return relationship;
  }

  if (typeof link.type === "string") {
    return link.type.trim() || undefined;
  }

  return (
    link.type?.key?.trim() ||
    link.type?.display?.trim() ||
    link.type?.inward?.trim() ||
    link.type?.outward?.trim() ||
    undefined
  );
};

const buildIssueLink = (
  link: TrackerIssueLinkResponseItem,
): TrackerIssueLink | undefined => {
  const targetIssueKey =
    link.object?.key?.trim() ||
    link.issue?.key?.trim() ||
    link.linkedIssue?.key?.trim() ||
    link.target?.key?.trim();
  const linkType = extractLinkType(link);
  if (!targetIssueKey || !linkType) {
    return undefined;
  }

  const direction =
    link.direction === "inward" || link.direction === "outward"
      ? link.direction
      : "unknown";

  return {
    id: link.id?.trim(),
    targetIssueKey,
    linkType,
    direction,
  };
};

const buildTransition = (
  transition: TrackerTransitionResponseItem,
): TrackerTransition | undefined => {
  const id = transition.id?.trim();
  if (!id) {
    return undefined;
  }

  return {
    id,
    key: transition.key?.trim(),
    display: transition.display?.trim(),
    toKey: transition.to?.key?.trim(),
    toDisplay: transition.to?.display?.trim(),
  };
};

const extractCollection = <T>(
  response: T[] | TrackerCollectionResponse<T>,
): T[] => {
  if (Array.isArray(response)) {
    return response;
  }

  return response.values ?? response.comments ?? response.transitions ?? response.items ?? [];
};

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

  async checkReadAccess(): Promise<void> {
    const response = await this.request<
      TrackerSearchResponseItem[] | TrackerCollectionResponse<TrackerSearchResponseItem>
    >("/issues/_search", {
      method: "POST",
      query: { page: 1, perPage: 1 },
      body: {
        query: `"Queue": "${escapeTrackerQueryValue(this.config.trackerDefaultQueue)}" AND "Tags": "${escapeTrackerQueryValue(this.config.trackerTag)}"`,
      },
    });

    extractCollection(response);
  }

  async findCandidateIssues(input: { queue?: string; tag?: string } = {}): Promise<TrackerIssue[]> {
    const issues = await this.searchIssuesByTag(input);
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
    const comments = await this.fetchAllPages<TrackerComment>(`/issues/${issueKey}/comments`);

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
        isSystem: comment.isSystem === true,
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
    const transition = await this.resolveTransition(issueKey, targetStatus);

    await this.request(`/issues/${issueKey}/transitions/${transition}/_execute`, {
      method: "POST",
    });
  }

  async createIssue(input: CreateTrackerIssueInput): Promise<TrackerIssue> {
    const issue = await this.request<TrackerSearchResponseItem>("/issues", {
      method: "POST",
      body: {
        queue: input.queue,
        summary: input.title,
        description: input.description,
        tags: input.tags ?? [],
      },
    });
    const built = buildIssue(issue);
    return {
      ...built,
      logicalStatus: this.determineLogicalStatus(built),
    };
  }

  async linkIssue(input: LinkTrackerIssueInput): Promise<void> {
    await this.request(`/issues/${input.sourceIssueKey}/links`, {
      method: "POST",
      body: {
        relationship: input.linkType,
        issue: input.targetIssueKey,
      },
    });
  }

  async getIssueLinks(issueKey: string): Promise<TrackerIssueLink[]> {
    const links = await this.fetchAllPages<TrackerIssueLinkResponseItem>(
      `/issues/${issueKey}/links`,
    );

    return links
      .map(buildIssueLink)
      .filter((link): link is TrackerIssueLink => link !== undefined);
  }

  private async searchIssuesByTag(
    input: { queue?: string; tag?: string } = {},
  ): Promise<TrackerSearchResponseItem[]> {
    const queue = input.queue ?? this.config.trackerDefaultQueue;
    const tag = input.tag ?? this.config.trackerTag;
    const result = await this.fetchAllPages<TrackerSearchResponseItem>("/issues/_search", {
      method: "POST",
      body: {
        query: `"Queue": "${escapeTrackerQueryValue(queue)}" AND "Tags": "${escapeTrackerQueryValue(tag)}"`,
      },
    });

    this.logger.info("Fetched tracker candidates.", { count: result.length, queue, tag });
    return result;
  }

  private async fetchAllPages<T>(
    path: string,
    options: TrackerRequestOptions = {},
  ): Promise<T[]> {
    const perPage = Number(options.query?.perPage ?? DEFAULT_PAGE_SIZE);
    const items: T[] = [];

    for (let page = 1; ; page += 1) {
      const response = await this.request<T[] | TrackerCollectionResponse<T>>(path, {
        ...options,
        query: {
          ...(options.query ?? {}),
          page,
          perPage,
        },
      });
      const pageItems = extractCollection(response);
      items.push(...pageItems);

      if (pageItems.length < perPage) {
        return items;
      }
    }
  }

  private async getTransitions(issueKey: string): Promise<TrackerTransition[]> {
    const response = await this.request<
      TrackerTransitionResponseItem[] | TrackerCollectionResponse<TrackerTransitionResponseItem>
    >(`/issues/${issueKey}/transitions`);

    return extractCollection(response)
      .map(buildTransition)
      .filter((transition): transition is TrackerTransition => transition !== undefined);
  }

  private async resolveTransition(
    issueKey: string,
    targetStatus: LogicalStatus,
  ): Promise<string> {
    const transitions = await this.getTransitions(issueKey);
    const statusConfig = this.config.trackerStatusMap[targetStatus];
    const transitionHint = normalize(statusConfig.transition);
    const statusMatchers = statusConfig.statuses.map(normalize);

    const byHint = transitionHint
      ? transitions.find((transition) =>
          getTransitionCandidates(transition).includes(transitionHint),
        )
      : undefined;

    if (byHint) {
      return byHint.id;
    }

    const byStatus = transitions.find((transition) =>
      getTransitionCandidates(transition).some((candidate) =>
        statusMatchers.includes(candidate),
      ),
    );

    if (byStatus) {
      return byStatus.id;
    }

    const availableTransitions = transitions
      .map((transition) =>
        [
          `id=${transition.id}`,
          transition.key ? `key=${transition.key}` : undefined,
          transition.display ? `display=${transition.display}` : undefined,
          transition.toKey ? `to.key=${transition.toKey}` : undefined,
          transition.toDisplay ? `to.display=${transition.toDisplay}` : undefined,
        ]
          .filter(Boolean)
          .join(" "),
      )
      .join("; ");

    throw new ConfigurationError(
      `No tracker transition found for logical status ${targetStatus}. Available transitions: ${
        availableTransitions || "none"
      }`,
    );
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
            [this.config.trackerOrgHeader]: this.config.trackerOrgId,
            "Content-Type": "application/json",
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        }).catch((error) => {
          throw new TemporaryIntegrationError(`Tracker request failed: ${path}`, error);
        });

        if (response.status === 429) {
          throw new TemporaryIntegrationError(
            `Tracker rate limit error for ${path}`,
            undefined,
            parseRetryAfterMs(response.headers.get("Retry-After")),
          );
        }

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

const getTransitionCandidates = (transition: TrackerTransition): string[] =>
  [
    transition.id,
    transition.key,
    transition.display,
    transition.toKey,
    transition.toDisplay,
  ]
    .map((value) => normalize(value))
    .filter(Boolean);

const parseRetryAfterMs = (value: string | null): number | undefined => {
  if (!value) {
    return undefined;
  }

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds) * 1000;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return Math.max(0, timestamp - Date.now());
};
