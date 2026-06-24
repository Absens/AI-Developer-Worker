import { describe, expect, it } from "vitest";

import {
  createTaskIntakeFingerprint,
  limitTaskIntakeReviewQuestions,
  parseTaskIntakeReviewDecision,
} from "../src/domain/taskIntakeReview.js";
import type {
  CommentWithMetadata,
  TaskIntakeReviewDecision,
  TrackerIssue,
} from "../src/models/types.js";

const issue: TrackerIssue = {
  id: "1",
  key: "DEV-1",
  title: "Исправить экран профиля",
  description: "Кнопка сохранения не видна на мобильном экране.",
  queue: "DEV",
  priority: "normal",
  deadline: "2026-06-30",
  components: ["frontend"],
  tags: ["ai_task_analysis"],
};

describe("task intake review", () => {
  it("parses a valid AI_TASK_REVIEW line", () => {
    const decision = parseTaskIntakeReviewDecision(
      'AI_TASK_REVIEW: {"status":"needs_clarification","readinessScore":35,"summary":"The task needs the affected screen and expected behavior clarified.","rewrittenTitle":"Clarify profile save button visibility on mobile","rewrittenDescription":"The profile screen save button is not visible on mobile. Clarify the affected viewport, expected placement, and reproduction steps before implementation.","acceptanceCriteria":[],"clarificationQuestions":["Which profile screen or route is affected?","What mobile viewport should be supported?","Where should the save button appear?"],"decompositionHints":[],"riskFactors":["The affected screen is unknown."],"reasoning":"The issue describes a symptom but omits the exact screen, viewport, and expected behavior."}',
    );

    expect(decision).toEqual({
      status: "needs_clarification",
      readinessScore: 35,
      summary: "The task needs the affected screen and expected behavior clarified.",
      rewrittenTitle: "Clarify profile save button visibility on mobile",
      rewrittenDescription:
        "The profile screen save button is not visible on mobile. Clarify the affected viewport, expected placement, and reproduction steps before implementation.",
      acceptanceCriteria: [],
      clarificationQuestions: [
        "Which profile screen or route is affected?",
        "What mobile viewport should be supported?",
        "Where should the save button appear?",
      ],
      decompositionHints: [],
      riskFactors: ["The affected screen is unknown."],
      reasoning:
        "The issue describes a symptom but omits the exact screen, viewport, and expected behavior.",
    });
  });

  it("parses raw JSON output from Codex output-schema runs", () => {
    const decision = parseTaskIntakeReviewDecision(
      '{"status":"ready","readinessScore":95,"summary":"The task is ready for implementation.","acceptanceCriteria":["The button is visible on mobile."],"clarificationQuestions":[],"decompositionHints":[],"riskFactors":[],"reasoning":"The issue includes scope and expected behavior."}',
    );

    expect(decision).toMatchObject({
      status: "ready",
      readinessScore: 95,
      acceptanceCriteria: ["The button is visible on mobile."],
    });
  });

  it("rejects malformed review decisions safely", () => {
    expect(parseTaskIntakeReviewDecision("READY")).toBeUndefined();
    expect(
      parseTaskIntakeReviewDecision(
        'AI_TASK_REVIEW: {"status":"ready","readinessScore":101,"summary":"Ready.","reasoning":"Score is outside the allowed range."}',
      ),
    ).toBeUndefined();
  });

  it("trims status before validating review decisions", () => {
    const decision = parseTaskIntakeReviewDecision(
      'AI_TASK_REVIEW: {"status":" ready ","readinessScore":100,"summary":"Ready to implement.","reasoning":"The task is clear."}',
    );

    expect(decision?.status).toBe("ready");
  });

  it("caps clarification questions at the configured maximum", () => {
    const decision: TaskIntakeReviewDecision = {
      status: "needs_clarification",
      readinessScore: 35,
      summary: "Missing context.",
      acceptanceCriteria: [],
      clarificationQuestions: ["Question 1?", "Question 2?", "Question 3?"],
      decompositionHints: [],
      riskFactors: [],
      reasoning: "The task lacks required implementation details.",
    };

    expect(limitTaskIntakeReviewQuestions(decision, 2)).toEqual({
      ...decision,
      clarificationQuestions: ["Question 1?", "Question 2?"],
    });
  });

  it("creates a stable fingerprint that changes when issue or human comments change", () => {
    const comments: CommentWithMetadata[] = [
      {
        id: "comment-1",
        text: "Нужно проверить адаптивную верстку.",
        createdAt: "2026-06-09T01:00:00.000Z",
        author: "ivan",
        isSystem: false,
      },
      {
        id: "comment-2",
        text: "AI STATUS: working",
        createdAt: "2026-06-09T01:01:00.000Z",
        author: "worker",
        isSystem: true,
      },
      {
        id: "comment-3",
        text: "AI ANALYSIS: {}",
        createdAt: "2026-06-09T01:02:00.000Z",
        author: "worker",
        isSystem: false,
        metadata: {
          kind: "AI ANALYSIS",
          worker: "worker-1",
        },
      },
    ];

    const fingerprint = createTaskIntakeFingerprint(issue, comments);
    const changedIssueFingerprint = createTaskIntakeFingerprint(
      {
        ...issue,
        description: "Кнопка сохранения не видна на мобильном экране после скролла.",
      },
      comments,
    );
    const changedCommentFingerprint = createTaskIntakeFingerprint(issue, [
      {
        id: "comment-1",
        text: "Нужно проверить адаптивную верстку и sticky footer.",
        createdAt: "2026-06-09T01:00:00.000Z",
        author: "ivan",
        isSystem: false,
      },
    ]);

    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(changedIssueFingerprint).not.toBe(fingerprint);
    expect(changedCommentFingerprint).not.toBe(fingerprint);
  });

  it("canonicalizes set-like issue fields before fingerprinting", () => {
    const orderedFingerprint = createTaskIntakeFingerprint(
      {
        ...issue,
        tags: ["ai_task_analysis", "mobile"],
        components: ["frontend", "profile"],
      },
      [],
    );
    const reorderedFingerprint = createTaskIntakeFingerprint(
      {
        ...issue,
        tags: ["mobile", "ai_task_analysis"],
        components: ["profile", "frontend"],
      },
      [],
    );

    expect(reorderedFingerprint).toBe(orderedFingerprint);
  });

  it("canonicalizes human comments before fingerprinting", () => {
    const firstComment: CommentWithMetadata = {
      id: "comment-1",
      text: "Первый комментарий.",
      createdAt: "2026-06-09T01:00:00.000Z",
      author: "ivan",
      isSystem: false,
    };
    const secondComment: CommentWithMetadata = {
      id: "comment-2",
      text: "Второй комментарий.",
      createdAt: "2026-06-09T01:00:00.000Z",
      author: "olga",
      isSystem: false,
    };
    const thirdComment: CommentWithMetadata = {
      id: "comment-3",
      text: "Третий комментарий.",
      createdAt: "2026-06-09T01:01:00.000Z",
      author: "ivan",
      isSystem: false,
    };

    expect(
      createTaskIntakeFingerprint(issue, [
        firstComment,
        secondComment,
        thirdComment,
      ]),
    ).toBe(
      createTaskIntakeFingerprint(issue, [
        thirdComment,
        secondComment,
        firstComment,
      ]),
    );
  });

  it("excludes AI metadata and system comments from fingerprinting", () => {
    const humanComment: CommentWithMetadata = {
      id: "comment-1",
      text: "Нужно проверить адаптивную верстку.",
      createdAt: "2026-06-09T01:00:00.000Z",
      author: "ivan",
      isSystem: false,
    };
    const fingerprint = createTaskIntakeFingerprint(issue, [humanComment]);

    expect(
      createTaskIntakeFingerprint(issue, [
        humanComment,
        {
          id: "comment-2",
          text: "AI STATUS: working",
          createdAt: "2026-06-09T01:01:00.000Z",
          author: "worker",
          isSystem: true,
        },
        {
          id: "comment-3",
          text: "AI ANALYSIS: {}",
          createdAt: "2026-06-09T01:02:00.000Z",
          author: "worker",
          isSystem: false,
          metadata: {
            kind: "AI ANALYSIS",
            worker: "worker-1",
          },
        },
      ]),
    ).toBe(fingerprint);
  });
});
