import type {
  AppConfig,
  GitLabService,
  MergeRequestDiscussion,
  MergeRequestInfo,
  MergeRequestNote,
} from "../../models/types.js";
import { TemporaryIntegrationError } from "../../utils/errors.js";
import { Logger } from "../../utils/logger.js";
import { withRetry } from "../../utils/retry.js";

interface GitLabMergeRequestResponse {
  id: number;
  iid: number;
  web_url: string;
  title: string;
  source_branch: string;
  target_branch: string;
  state?: string;
  merged_at?: string | null;
  closed_at?: string | null;
  updated_at?: string;
}

interface GitLabUserResponse {
  username: string;
}

interface GitLabDiscussionResponse {
  id: string;
  individual_note: boolean;
  resolved?: boolean;
  notes: GitLabNoteResponse[];
}

interface GitLabNoteResponse {
  id: number;
  body: string;
  author?: {
    username?: string;
  };
  system: boolean;
  resolvable: boolean;
  resolved: boolean;
  created_at: string;
  position?: {
    new_path?: string;
    old_path?: string;
    new_line?: number;
    old_line?: number;
  };
}

const toMergeRequestInfo = (
  payload: GitLabMergeRequestResponse,
): MergeRequestInfo => ({
  id: payload.id,
  iid: payload.iid,
  url: payload.web_url,
  title: payload.title,
  sourceBranch: payload.source_branch,
  targetBranch: payload.target_branch,
  ...(payload.state ? { state: payload.state } : {}),
  ...(payload.merged_at ? { mergedAt: payload.merged_at } : {}),
  ...(payload.closed_at ? { closedAt: payload.closed_at } : {}),
  ...(payload.updated_at ? { updatedAt: payload.updated_at } : {}),
});

class GitLabNotFoundError extends Error {
  constructor(path: string, body: string) {
    super(`GitLab request failed for ${path}: 404 ${body}`);
    this.name = "GitLabNotFoundError";
  }
}

const toMergeRequestNote = (payload: GitLabNoteResponse): MergeRequestNote => ({
  id: payload.id,
  body: payload.body,
  authorUsername: payload.author?.username ?? "",
  system: payload.system,
  resolvable: payload.resolvable,
  resolved: payload.resolved,
  createdAt: payload.created_at,
  ...(payload.position
    ? {
        position: {
          ...(payload.position.new_path ? { newPath: payload.position.new_path } : {}),
          ...(payload.position.old_path ? { oldPath: payload.position.old_path } : {}),
          ...(payload.position.new_line !== undefined
            ? { newLine: payload.position.new_line }
            : {}),
          ...(payload.position.old_line !== undefined
            ? { oldLine: payload.position.old_line }
            : {}),
        },
      }
    : {}),
});

const toMergeRequestDiscussion = (
  payload: GitLabDiscussionResponse,
): MergeRequestDiscussion => {
  const notes = payload.notes.map(toMergeRequestNote);
  const resolved =
    typeof payload.resolved === "boolean"
      ? payload.resolved
      : notes.every((note) => !note.resolvable || note.resolved);

  return {
    id: payload.id,
    individualNote: payload.individual_note,
    resolved,
    notes,
  };
};

export class GitLabApiClient implements GitLabService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async checkReadAccess(): Promise<void> {
    const projectPath = `/projects/${encodeURIComponent(this.config.gitlabProjectId)}`;
    await this.request(projectPath);
    await this.request(`${projectPath}/merge_requests`, {
      query: {
        state: "opened",
        per_page: "1",
      },
    });
  }

  async checkMergeRequestWriteAccess(sourceBranch: string): Promise<MergeRequestInfo> {
    const existing = await this.findOpenMergeRequestByBranch(sourceBranch);
    if (existing) {
      return existing;
    }

    const response = await this.request<GitLabMergeRequestResponse>(
      `/projects/${encodeURIComponent(this.config.gitlabProjectId)}/merge_requests`,
      {
        method: "POST",
        body: {
          source_branch: sourceBranch,
          target_branch: this.config.baseBranch,
          title: `[AI Preflight] ${sourceBranch}`,
          description:
            "Draft merge request created by the AI Developer Worker preflight check.",
          draft: true,
        },
      },
    );

    return toMergeRequestInfo(response);
  }

  async findOpenMergeRequestByBranch(
    sourceBranch: string,
  ): Promise<MergeRequestInfo | null> {
    const response = await this.request<GitLabMergeRequestResponse[]>(
      `/projects/${encodeURIComponent(this.config.gitlabProjectId)}/merge_requests`,
      {
        query: {
          state: "opened",
          source_branch: sourceBranch,
        },
      },
    );

    return response[0] ? toMergeRequestInfo(response[0]) : null;
  }

  async findMergeRequestByBranch(sourceBranch: string): Promise<MergeRequestInfo | null> {
    const response = await this.request<GitLabMergeRequestResponse[]>(
      `/projects/${encodeURIComponent(this.config.gitlabProjectId)}/merge_requests`,
      {
        query: {
          state: "all",
          source_branch: sourceBranch,
          order_by: "updated_at",
          sort: "desc",
        },
      },
    );

    return response[0] ? toMergeRequestInfo(response[0]) : null;
  }

  async getMergeRequest(iid: number): Promise<MergeRequestInfo | null> {
    try {
      const response = await this.request<GitLabMergeRequestResponse>(
        `/projects/${encodeURIComponent(this.config.gitlabProjectId)}/merge_requests/${iid}`,
      );

      return toMergeRequestInfo(response);
    } catch (error) {
      if (error instanceof GitLabNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async createMergeRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string;
  }): Promise<MergeRequestInfo> {
    const response = await this.request<GitLabMergeRequestResponse>(
      `/projects/${encodeURIComponent(this.config.gitlabProjectId)}/merge_requests`,
      {
        method: "POST",
        body: {
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
          title: input.title,
          description: input.description,
        },
      },
    );

    return toMergeRequestInfo(response);
  }

  async getMergeRequestDiscussions(iid: number): Promise<MergeRequestDiscussion[]> {
    const response = await this.fetchAllPages<GitLabDiscussionResponse>(
      `/projects/${encodeURIComponent(this.config.gitlabProjectId)}/merge_requests/${iid}/discussions`,
    );

    return response.map(toMergeRequestDiscussion);
  }

  async replyToDiscussion(iid: number, discussionId: string, body: string): Promise<void> {
    await this.request(
      `/projects/${encodeURIComponent(this.config.gitlabProjectId)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`,
      {
        method: "POST",
        body: { body },
      },
    );
  }

  async getCurrentUser(): Promise<{ username: string }> {
    const response = await this.request<GitLabUserResponse>("/user");
    return { username: response.username };
  }

  private async fetchAllPages<T>(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string | number>;
      body?: unknown;
    } = {},
  ): Promise<T[]> {
    const perPage = Number(options.query?.per_page ?? 100);
    const items: T[] = [];

    for (let page = 1; ; page += 1) {
      const pageItems = await this.request<T[]>(path, {
        ...options,
        query: {
          ...(options.query ?? {}),
          page,
          per_page: perPage,
        },
      });
      items.push(...pageItems);

      if (pageItems.length < perPage) {
        return items;
      }
    }
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string | number>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    return withRetry(
      async () => {
        const url = new URL(`${this.config.gitlabUrl}/api/v4${path}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
          url.searchParams.set(key, String(value));
        }

        const response = await fetch(url, {
          method: options.method ?? "GET",
          headers: {
            "PRIVATE-TOKEN": this.config.gitlabToken,
            "Content-Type": "application/json",
          },
          body: options.body === undefined ? null : JSON.stringify(options.body),
        }).catch((error) => {
          throw new TemporaryIntegrationError(`GitLab request failed: ${path}`, error);
        });

        if (response.status >= 500) {
          throw new TemporaryIntegrationError(
            `GitLab temporary error ${response.status} for ${path}`,
          );
        }

        if (!response.ok) {
          const body = await response.text();
          if (response.status === 404) {
            throw new GitLabNotFoundError(path, body);
          }
          throw new Error(`GitLab request failed for ${path}: ${response.status} ${body}`);
        }

        return (await response.json()) as T;
      },
      {
        retries: 3,
        delayMs: 500,
        label: `gitlab:${path}`,
        logger: this.logger,
      },
    );
  }
}
