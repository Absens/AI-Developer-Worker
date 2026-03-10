import { describe, expect, it } from "vitest";

import {
  findFirstHumanReplyAfter,
  formatMergeRequestComment,
  formatQuestionComment,
  formatStatusComment,
  parseServiceComment,
} from "../src/integrations/tracker/commentProtocol.js";
import type { CommentWithMetadata } from "../src/models/types.js";

describe("comment protocol", () => {
  it("formats and parses AI STATUS comments", () => {
    const text = formatStatusComment("worker-1", "in_progress", "Started");
    expect(parseServiceComment(text)).toEqual({
      kind: "AI STATUS",
      worker: "worker-1",
      state: "in_progress",
      details: "Started",
    });
  });

  it("formats AI QUESTION and AI MR comments", () => {
    expect(parseServiceComment(formatQuestionComment("worker-1", "Need access?"))).toEqual({
      kind: "AI QUESTION",
      worker: "worker-1",
      question: "Need access?",
    });

    expect(
      parseServiceComment(
        formatMergeRequestComment("worker-1", "https://gitlab/mr/1", "feature/ai-task-ABC-1"),
      ),
    ).toEqual({
      kind: "AI MR",
      worker: "worker-1",
      url: "https://gitlab/mr/1",
      branch: "feature/ai-task-ABC-1",
    });
  });

  it("finds the first human reply after an AI question", () => {
    const comments: CommentWithMetadata[] = [
      {
        id: "1",
        text: formatQuestionComment("worker-1", "Which endpoint should be used?"),
        createdAt: "2026-03-10T10:00:00.000Z",
        isSystem: false,
        metadata: parseServiceComment(
          formatQuestionComment("worker-1", "Which endpoint should be used?"),
        ),
      },
      {
        id: "2",
        text: "Use the v2 endpoint.",
        createdAt: "2026-03-10T10:05:00.000Z",
        isSystem: false,
      },
    ];

    expect(
      findFirstHumanReplyAfter(comments, "2026-03-10T10:00:00.000Z")?.text,
    ).toBe("Use the v2 endpoint.");
  });
});
