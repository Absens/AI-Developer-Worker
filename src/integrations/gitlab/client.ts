import type { AppConfig, GitLabService, MergeRequestInfo } from "../../models/types.js";
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
});

export class GitLabApiClient implements GitLabService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

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

  private async request<T>(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    return withRetry(
      async () => {
        const url = new URL(`${this.config.gitlabUrl}/api/v4${path}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
          url.searchParams.set(key, value);
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
