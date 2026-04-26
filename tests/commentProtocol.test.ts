import { describe, expect, it } from "vitest";

import {
  findFirstHumanReplyAfter,
  findLatestHumanTaskCommandAfter,
  findLatestReviewMetadata,
  formatMergeRequestComment,
  formatQuestionComment,
  formatQuestionCommentWithThreadId,
  formatReviewMetadataComment,
  formatStatusComment,
  parseHumanTaskCommand,
  parseServiceComment,
} from "../src/integrations/tracker/commentProtocol.js";
import type { ClarificationQuestion, CommentWithMetadata } from "../src/models/types.js";

const clarification: ClarificationQuestion = {
  summary: "Need a decision about the API variant.",
  blockingReason: "The implementation differs depending on the endpoint contract.",
  question: "Which API variant should be used?",
  options: ["A: use v1", "B: use v2"],
  resumeHint: "Reply with /resume A or /resume B.",
};

const quotedResumeReply = `> [В ответ на](https://tracker.yandex.ru/FRONTEND-1790#69b271f5a8bdec7429c71cbc){data-quotelink=true}
> 
> AI QUESTION:
>
> Need a decision about the API variant.
>
> Question: Which API variant should be used?
> Blocking reason: The implementation differs depending on the endpoint contract.
>
> Options:
>
> - A: use v1
> - B: use v2
>
> ::: html
> To continue:
Reply with /resume A or /resume B.
> :::

/resume B`;

describe("comment protocol", () => {
  it("formats and parses AI STATUS comments", () => {
    const text = formatStatusComment(
      "worker-1",
      "waiting_for_answer",
      "Waiting for explicit /resume command after clarification.",
      "clarification",
    );
    expect(parseServiceComment(text)).toEqual({
      kind: "AI STATUS",
      worker: "worker-1",
      state: "waiting_for_answer",
      details: "Waiting for explicit /resume command after clarification.",
      waitingReason: "clarification",
    });
  });

  it("formats and parses structured AI QUESTION and AI MR comments", () => {
    expect(parseServiceComment(formatQuestionComment("worker-1", clarification))).toEqual({
      kind: "AI QUESTION",
      worker: "worker-1",
      mode: "clarification",
      waitingReason: "clarification",
      question: "Which API variant should be used?",
      summary: "Need a decision about the API variant.",
      blockingReason: "The implementation differs depending on the endpoint contract.",
      options: ["A: use v1", "B: use v2"],
      resumeHint: "Reply with /resume A or /resume B.",
    });
    expect(
      parseServiceComment(
        formatQuestionCommentWithThreadId("worker-1", clarification, "thread-123"),
      ),
    ).toEqual({
      kind: "AI QUESTION",
      worker: "worker-1",
      threadId: "thread-123",
      mode: "clarification",
      waitingReason: "clarification",
      question: "Which API variant should be used?",
      summary: "Need a decision about the API variant.",
      blockingReason: "The implementation differs depending on the endpoint contract.",
      options: ["A: use v1", "B: use v2"],
      resumeHint: "Reply with /resume A or /resume B.",
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

  it("formats, parses, and finds latest AI REVIEW metadata", () => {
    const first = formatReviewMetadataComment({
      worker: "worker-1",
      issueKey: "DEV-1",
      mergeRequestIid: 17,
      processedDiscussionIds: ["abc"],
      processedNoteIds: [101],
      lastFixCommit: "sha-1",
    });
    const second = formatReviewMetadataComment({
      worker: "worker-1",
      issueKey: "DEV-1",
      mergeRequestIid: 17,
      processedDiscussionIds: ["abc", "def"],
      processedNoteIds: [101, 102],
      lastFixCommit: "sha-2",
    });

    expect(parseServiceComment(first)).toEqual({
      kind: "AI REVIEW",
      worker: "worker-1",
      issueKey: "DEV-1",
      mergeRequestIid: 17,
      processedDiscussionIds: ["abc"],
      processedNoteIds: [101],
      lastFixCommit: "sha-1",
    });

    const comments: CommentWithMetadata[] = [
      {
        id: "1",
        text: first,
        createdAt: "2026-03-10T10:00:00.000Z",
        isSystem: false,
        metadata: parseServiceComment(first),
      },
      {
        id: "2",
        text: second,
        createdAt: "2026-03-10T10:05:00.000Z",
        isSystem: false,
        metadata: parseServiceComment(second),
      },
    ];

    expect(findLatestReviewMetadata(comments, "DEV-1", 17)).toEqual({
      worker: "worker-1",
      issueKey: "DEV-1",
      mergeRequestIid: 17,
      processedDiscussionIds: ["abc", "def"],
      processedNoteIds: [101, 102],
      lastFixCommit: "sha-2",
    });
  });

  it("parses human task commands and finds the latest resume command", () => {
    expect(parseHumanTaskCommand("/resume A")).toEqual({
      type: "resume",
      rawText: "/resume A",
      choice: "A",
    });
    expect(parseHumanTaskCommand("/resume freeform: use the v2 endpoint")).toEqual({
      type: "resume",
      rawText: "/resume freeform: use the v2 endpoint",
      freeform: "use the v2 endpoint",
    });
    expect(parseHumanTaskCommand(quotedResumeReply)).toEqual({
      type: "resume",
      rawText: quotedResumeReply.trim(),
      choice: "B",
    });

    const comments: CommentWithMetadata[] = [
      {
        id: "1",
        text: formatQuestionComment("worker-1", clarification),
        createdAt: "2026-03-10T10:00:00.000Z",
        isSystem: false,
        metadata: parseServiceComment(formatQuestionComment("worker-1", clarification)),
      },
      {
        id: "2",
        text: "I think v2 is safer.",
        createdAt: "2026-03-10T10:05:00.000Z",
        isSystem: false,
      },
      {
        id: "3",
        text: "/resume B",
        createdAt: "2026-03-10T10:06:00.000Z",
        isSystem: false,
      },
      {
        id: "4",
        text: quotedResumeReply,
        createdAt: "2026-03-10T10:07:00.000Z",
        isSystem: false,
      },
    ];

    expect(
      findLatestHumanTaskCommandAfter(comments, "2026-03-10T10:00:00.000Z"),
    ).toEqual({
      type: "resume",
      rawText: quotedResumeReply.trim(),
      choice: "B",
    });
  });

  it("finds the first human reply after an AI question", () => {
    const questionText = formatQuestionComment("worker-1", clarification);
    const comments: CommentWithMetadata[] = [
      {
        id: "1",
        text: questionText,
        createdAt: "2026-03-10T10:00:00.000Z",
        isSystem: false,
        metadata: parseServiceComment(questionText),
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
