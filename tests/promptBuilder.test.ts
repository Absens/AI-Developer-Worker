import { describe, expect, it } from "vitest";

import {
  buildAnalysisPrompt,
  buildImplementationPrompt,
  buildTaskIntakeReviewPrompt,
} from "../src/domain/promptBuilder.js";
import { getPromptProfile } from "../src/domain/promptProfiles.js";
import type {
  PromptContextBundle,
} from "../src/domain/promptContext.js";
import type {
  CommentWithMetadata,
  TaskAnalysisDecision,
  TrackerIssue,
} from "../src/models/types.js";

const issue: TrackerIssue = {
  id: "1",
  key: "FRONTEND-1",
  title: "Fix Button",
  description: "Button has broken focus styles.",
};

const decision: TaskAnalysisDecision = {
  confidence: 88,
  taskType: "frontend_ui_fix",
  recommendedMode: "implement",
  promptProfileId: "frontend_ui_fix",
  expectedFiles: ["src/Button.tsx"],
  expectedSubsystems: ["ui"],
  riskFactors: ["visual regression"],
  missingContext: [],
  reasoning: "Localized component fix.",
};

const memoryContext: PromptContextBundle = {
  repositoryName: "client-application",
  taskType: "frontend_ui_fix",
  promptProfileId: "frontend_ui_fix",
  instructionSources: [
    {
      id: "memory",
      title: "Repository memory",
      body: "Current repository files remain authoritative.",
    },
  ],
  knowledgeSections: [
    {
      id: "arch-ui",
      title: "UI architecture",
      body: "Shared components live under src/components.",
      source: "manual",
      sourceRefs: ["README.md"],
      tags: ["ui"],
      taskTypes: ["frontend_ui_fix"],
      confidence: 90,
      updatedAt: "2026-04-27T00:00:00.000Z",
    },
  ],
  promptRules: [],
  similarFailures: [],
  contextBudgetChars: 1000,
};

const imageContext = {
  promptSummary: [
    "Tracker image attachments passed to Codex:",
    "- Image 1: screen.png, mimetype=image/png, size=2048 bytes, dimensions=1280x720",
  ].join("\n"),
};

describe("prompt builder", () => {
  it("asks analysis for structured AI_ANALYSIS output", () => {
    const prompt = buildAnalysisPrompt(issue, []);

    expect(prompt).toContain("AI_ANALYSIS:");
    expect(prompt).toContain('"confidence": 82');
    expect(prompt).not.toContain("READY_FOR_IMPLEMENTATION");
  });

  it("includes prompt profile and analysis context in implementation prompts", () => {
    const prompt = buildImplementationPrompt(
      issue,
      [],
      getPromptProfile("frontend_ui_fix"),
      decision,
    );

    expect(prompt).toContain("Prompt profile: frontend_ui_fix");
    expect(prompt).toContain("Structured analysis:");
    expect(prompt).toContain("Visual regression");
  });

  it("includes repository memory context when a bundle is provided", () => {
    const prompt = buildAnalysisPrompt(issue, [], memoryContext);

    expect(prompt).toContain("Repository context:");
    expect(prompt).toContain("[arch-ui] UI architecture");
  });

  it("keeps memory-disabled prompts free of repository context", () => {
    const prompt = buildImplementationPrompt(
      issue,
      [],
      getPromptProfile("frontend_ui_fix"),
      decision,
    );

    expect(prompt).not.toContain("Repository context:");
  });

  it("includes Tracker image context in analysis prompts", () => {
    const prompt = buildAnalysisPrompt(issue, [], undefined, imageContext);

    expect(prompt).toContain("Tracker image attachments passed to Codex:");
    expect(prompt).toContain("screen.png");
    expect(prompt).toContain("Use these attached images as task context");
  });

  it("includes Tracker image context in implementation prompts", () => {
    const prompt = buildImplementationPrompt(
      issue,
      [],
      getPromptProfile("frontend_ui_fix"),
      decision,
      undefined,
      imageContext,
    );

    expect(prompt).toContain("Tracker image attachments passed to Codex:");
    expect(prompt).toContain("screen.png");
    expect(prompt).toContain("Use these attached images as task context");
  });

  it("builds a task intake review prompt with the AI_TASK_REVIEW contract", () => {
    const prompt = buildTaskIntakeReviewPrompt(
      {
        id: "1",
        key: "DEV-10",
        title: "Сделать красиво",
        description: "Нужно улучшить экран",
        queue: "DEV",
        tags: ["ai_task_analysis"],
        logicalStatus: "open",
      },
      [],
      undefined,
      undefined,
      4,
    );

    expect(prompt).toContain("Mode: task-intake-review");
    expect(prompt).toContain("AI_TASK_REVIEW:");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("Do not invent missing business requirements");
    expect(prompt).toContain("readinessScore must be an integer from 0 to 100");
    expect(prompt).toContain("Use [] when no acceptance criteria are directly supported");
    expect(prompt).toContain('"clarificationQuestions"');
    expect(prompt).toContain("at most 4 clarification questions");
  });

  it("includes task intake review context from comments, memory, and images", () => {
    const comments: CommentWithMetadata[] = [
      {
        id: "comment-1",
        text: "Human comment: the checkout screen is affected.",
        createdAt: "2026-06-01T10:00:00.000Z",
        author: "alice",
        isSystem: false,
      },
    ];

    const prompt = buildTaskIntakeReviewPrompt(
      issue,
      comments,
      memoryContext,
      imageContext,
    );

    expect(prompt).toContain("[alice] Human comment: the checkout screen is affected.");
    expect(prompt).toContain("Repository context:");
    expect(prompt).toContain("[arch-ui] UI architecture");
    expect(prompt).toContain("Tracker image attachments passed to Codex:");
    expect(prompt).toContain("screen.png");
  });
});
