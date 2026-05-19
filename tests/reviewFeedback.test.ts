import { describe, expect, it } from "vitest";

import {
  findPendingReviewDiscussions,
  formatReviewReplyBody,
  mergeReviewMetadata,
} from "../src/domain/reviewFeedback.js";
import type {
  GitLabService,
  MergeRequestDiscussion,
  MergeRequestInfo,
} from "../src/models/types.js";

class FakeGitLabService implements Pick<
  GitLabService,
  "getCurrentUser" | "getMergeRequestDiscussions"
> {
  discussions: MergeRequestDiscussion[] = [];

  async getCurrentUser(): Promise<{ username: string }> {
    return { username: "ai-worker" };
  }

  async getMergeRequestDiscussions(_iid: number): Promise<MergeRequestDiscussion[]> {
    return this.discussions;
  }
}

const mergeRequest: MergeRequestInfo = {
  id: 894,
  iid: 894,
  url: "https://gitlab.example.com/project/-/merge_requests/894",
  title: "[AI] implementation",
  sourceBranch: "feature/ai-task-yt_FRONTEND-1996",
  targetBranch: "test",
  state: "opened",
};

describe("review feedback helpers", () => {
  it("keeps unresolved reviewer notes and ignores current-user notes", async () => {
    const gitlab = new FakeGitLabService();
    gitlab.discussions = [
      {
        id: "discussion-1",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 24737,
            body: "Please account for max.ru bot links.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:14:12.667Z",
            position: { newPath: "src/example.ts", newLine: 12 },
          },
          {
            id: 24740,
            body: "Worker reply should be ignored.",
            authorUsername: "ai-worker",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:15:12.667Z",
            position: { newPath: "src/example.ts", newLine: 12 },
          },
        ],
      },
    ];

    const pending = await findPendingReviewDiscussions({
      gitlab,
      mergeRequestIid: mergeRequest.iid,
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("discussion-1");
    expect(pending[0]?.notes.map((note) => note.id)).toEqual([24737]);
  });

  it("ignores discussions GitLab already marks as resolved", async () => {
    const gitlab = new FakeGitLabService();
    gitlab.discussions = [
      {
        id: "discussion-resolved",
        individualNote: false,
        resolved: true,
        notes: [
          {
            id: 24741,
            body: "Already resolved in GitLab.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: true,
            createdAt: "2026-05-18T15:16:12.667Z",
          },
        ],
      },
    ];

    const pending = await findPendingReviewDiscussions({
      gitlab,
      mergeRequestIid: mergeRequest.iid,
    });

    expect(pending).toEqual([]);
  });

  it("skips notes already recorded in review metadata", async () => {
    const gitlab = new FakeGitLabService();
    gitlab.discussions = [
      {
        id: "discussion-1",
        individualNote: false,
        resolved: false,
        notes: [
          {
            id: 24737,
            body: "Already fixed.",
            authorUsername: "reviewer",
            system: false,
            resolvable: true,
            resolved: false,
            createdAt: "2026-05-18T15:14:12.667Z",
          },
        ],
      },
    ];

    const pending = await findPendingReviewDiscussions({
      gitlab,
      mergeRequestIid: mergeRequest.iid,
      previousMetadata: {
        worker: "worker-1",
        issueKey: "yt_FRONTEND-1996",
        mergeRequestIid: 894,
        processedDiscussionIds: ["discussion-1"],
        processedNoteIds: [24737],
      },
    });

    expect(pending).toEqual([]);
  });

  it("merges metadata without duplicates", () => {
    const merged = mergeReviewMetadata({
      worker: "worker-1",
      issueKey: "yt_FRONTEND-1996",
      mergeRequestIid: 894,
      previousMetadata: {
        worker: "worker-1",
        issueKey: "yt_FRONTEND-1996",
        mergeRequestIid: 894,
        processedDiscussionIds: ["discussion-1"],
        processedNoteIds: [24737],
      },
      discussions: [
        {
          id: "discussion-1",
          individualNote: false,
          resolved: false,
          notes: [
            {
              id: 24737,
              body: "Already fixed.",
              authorUsername: "reviewer",
              system: false,
              resolvable: true,
              resolved: false,
              createdAt: "2026-05-18T15:14:12.667Z",
            },
            {
              id: 24739,
              body: "Fix conflicts.",
              authorUsername: "reviewer",
              system: false,
              resolvable: false,
              resolved: false,
              createdAt: "2026-05-18T15:23:51.647Z",
            },
          ],
        },
      ],
      lastFixCommit: "commit-1",
    });

    expect(merged.processedDiscussionIds).toEqual(["discussion-1"]);
    expect(merged.processedNoteIds).toEqual([24737, 24739]);
    expect(merged.lastFixCommit).toBe("commit-1");
  });

  it("formats the GitLab reply body", () => {
    expect(formatReviewReplyBody("commit-1", "- Tests: passed")).toBe(
      [
        "Applied the review feedback in commit commit-1.",
        "",
        "Validation:",
        "- Tests: passed",
      ].join("\n"),
    );
  });
});
