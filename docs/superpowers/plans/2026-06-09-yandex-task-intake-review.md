# Yandex Task Intake Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in worker mode that reviews poorly specified Yandex Tracker tasks tagged with `ai_task_analysis` and writes a structured clarification or rewrite suggestion comment without starting implementation.

**Architecture:** The feature adds a pre-implementation intake review path inside `WorkerOrchestrator.runOnce()` after target/owned work and before picking new implementation tasks. It reuses `TrackerClient.findCandidateIssues({ tag })`, Codex analysis execution, Tracker image context, structured Tracker comments, and optional task-only leases. The first release is comment-only: it does not edit Tracker descriptions, mutate tags, create branches, transition statuses, or open GitLab merge requests.

**Tech Stack:** Node.js, TypeScript ES modules, Vitest, existing Codex runner, existing Yandex Tracker client, existing structured comment protocol.

---

## File Structure

- Create `src/domain/taskIntakeReview.ts`: parse `AI_TASK_REVIEW:` Codex output, normalize review decisions, cap clarification questions, build deterministic source fingerprints.
- Modify `src/models/types.ts`: add task intake review config, decision, status, and parsed-comment fields.
- Modify `src/integrations/tracker/commentProtocol.ts`: add `AI TASK REVIEW:` structured service comments and latest-review lookup.
- Modify `src/domain/promptBuilder.ts`: add `buildTaskIntakeReviewPrompt()`.
- Modify `src/domain/orchestrator.ts`: scan intake review candidates after owned work and before new implementation work, then write review comments idempotently.
- Modify `src/observability/events.ts`: add task-intake Codex stage event types used by orchestration telemetry.
- Modify `src/config.ts`: parse env and fleet config for the new opt-in mode.
- Modify `README.md` and `docs/ENV_CONFIGURATION.md`: document mode, env vars, and operational behavior.
- Add `tests/taskIntakeReview.test.ts`: parser and fingerprint unit tests.
- Modify `tests/commentProtocol.test.ts`: structured comment format/parse tests.
- Modify `tests/promptBuilder.test.ts`: prompt contract test.
- Modify `tests/orchestrator.test.ts`: intake mode orchestration tests.
- Modify `tests/config.test.ts`: config defaults and env parsing tests.

## Task 1: Decision Model, Parser, And Fingerprint

**Files:**
- Create: `src/domain/taskIntakeReview.ts`
- Modify: `src/models/types.ts`
- Test: `tests/taskIntakeReview.test.ts`

- [ ] **Step 1: Write the failing parser and fingerprint tests**

Create `tests/taskIntakeReview.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  createTaskIntakeFingerprint,
  limitTaskIntakeReviewQuestions,
  parseTaskIntakeReviewDecision,
} from "../src/domain/taskIntakeReview.js";
import type { CommentWithMetadata, TrackerIssue } from "../src/models/types.js";

const issue: TrackerIssue = {
  id: "1",
  key: "DEV-1",
  title: "Сделать нормально",
  description: "Плохо работает форма",
  queue: "DEV",
  tags: ["ai_task_analysis"],
  logicalStatus: "open",
};

describe("task intake review", () => {
  it("parses a valid AI_TASK_REVIEW line", () => {
    const decision = parseTaskIntakeReviewDecision(
      'AI_TASK_REVIEW: {"status":"needs_clarification","readinessScore":35,"summary":"The task lacks observable acceptance criteria.","rewrittenTitle":"Clarify form submission failure","rewrittenDescription":"The current task does not include enough verified behavior to rewrite safely.","acceptanceCriteria":[],"clarificationQuestions":["Which form fails?","What exact behavior is expected?","How can the issue be reproduced?"],"decompositionHints":[],"riskFactors":["The affected screen is unknown."],"reasoning":"The description names a symptom but not the target workflow."}',
    );

    expect(decision).toEqual({
      status: "needs_clarification",
      readinessScore: 35,
      summary: "The task lacks observable acceptance criteria.",
      rewrittenTitle: "Clarify form submission failure",
      rewrittenDescription:
        "The current task does not include enough verified behavior to rewrite safely.",
      acceptanceCriteria: [],
      clarificationQuestions: [
        "Which form fails?",
        "What exact behavior is expected?",
        "How can the issue be reproduced?",
      ],
      decompositionHints: [],
      riskFactors: ["The affected screen is unknown."],
      reasoning: "The description names a symptom but not the target workflow.",
    });
  });

  it("rejects malformed output and out-of-range scores", () => {
    expect(parseTaskIntakeReviewDecision("READY")).toBeUndefined();
    expect(
      parseTaskIntakeReviewDecision(
        'AI_TASK_REVIEW: {"status":"ready","readinessScore":101}',
      ),
    ).toBeUndefined();
  });

  it("caps clarification questions at the configured maximum", () => {
    const decision = parseTaskIntakeReviewDecision(
      'AI_TASK_REVIEW: {"status":"needs_clarification","readinessScore":20,"summary":"Missing details.","acceptanceCriteria":[],"clarificationQuestions":["Which form?","What expected behavior?","How can it be reproduced?"],"decompositionHints":[],"riskFactors":[],"reasoning":"The task is under-specified."}',
    );

    expect(decision).toBeDefined();
    expect(limitTaskIntakeReviewQuestions(decision!, 2).clarificationQuestions).toEqual([
      "Which form?",
      "What expected behavior?",
    ]);
  });

  it("changes the fingerprint when human task input changes", () => {
    const comments: CommentWithMetadata[] = [
      {
        id: "1",
        text: "Initial human note",
        createdAt: "2026-06-09T06:00:00.000Z",
        isSystem: false,
      },
    ];

    const first = createTaskIntakeFingerprint(issue, comments);
    const second = createTaskIntakeFingerprint(
      { ...issue, description: "Плохо работает форма оплаты" },
      comments,
    );
    const third = createTaskIntakeFingerprint(issue, [
      ...comments,
      {
        id: "2",
        text: "Fails after clicking Save",
        createdAt: "2026-06-09T06:05:00.000Z",
        isSystem: false,
      },
    ]);

    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(second).not.toBe(first);
    expect(third).not.toBe(first);
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `npx vitest run tests/taskIntakeReview.test.ts`

Expected: fail with a module resolution error for `../src/domain/taskIntakeReview.js`.

- [ ] **Step 3: Add model types**

In `src/models/types.ts`, add these exports near the existing `TaskAnalysisDecision` and config types:

```ts
export type TaskIntakeReviewStatus =
  | "ready"
  | "needs_clarification"
  | "needs_decomposition"
  | "reject_as_invalid";

export interface TaskIntakeReviewDecision {
  status: TaskIntakeReviewStatus;
  readinessScore: number;
  summary: string;
  rewrittenTitle?: string;
  rewrittenDescription?: string;
  acceptanceCriteria: string[];
  clarificationQuestions: string[];
  decompositionHints: string[];
  riskFactors: string[];
  reasoning: string;
}

export interface TaskIntakeReviewConfig {
  enabled: boolean;
  tag: string;
  maxQuestions: number;
}
```

Add `taskIntakeReview?: TaskIntakeReviewConfig;` to `AppConfig` and `GlobalWorkerConfig`. `RepositoryRuntimeConfig` inherits the field from `AppConfig`, and Task 5 wires its runtime value.

- [ ] **Step 4: Implement parser and fingerprint helper**

Create `src/domain/taskIntakeReview.ts`:

```ts
import { createHash } from "node:crypto";

import type {
  CommentWithMetadata,
  TaskIntakeReviewDecision,
  TaskIntakeReviewStatus,
  TrackerIssue,
} from "../models/types.js";

const REVIEW_MARKER = "AI_TASK_REVIEW:";
const VALID_STATUSES = new Set<TaskIntakeReviewStatus>([
  "ready",
  "needs_clarification",
  "needs_decomposition",
  "reject_as_invalid",
]);

const normalizeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
};

const normalizeStatus = (value: unknown): TaskIntakeReviewStatus | undefined =>
  typeof value === "string" && VALID_STATUSES.has(value as TaskIntakeReviewStatus)
    ? (value as TaskIntakeReviewStatus)
    : undefined;

const normalizeReadinessScore = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }

  return value >= 0 && value <= 100 ? value : undefined;
};

const extractPayload = (message: string): Record<string, unknown> | undefined => {
  const trimmed = message.trim();
  if (!trimmed.startsWith(REVIEW_MARKER)) {
    return undefined;
  }

  const payload = trimmed.slice(REVIEW_MARKER.length).trim();
  if (!payload.startsWith("{")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export const normalizeTaskIntakeReviewDecision = (
  payload: Record<string, unknown>,
): TaskIntakeReviewDecision | undefined => {
  const status = normalizeStatus(payload.status);
  const readinessScore = normalizeReadinessScore(payload.readinessScore);
  const summary = normalizeString(payload.summary);
  const reasoning = normalizeString(payload.reasoning);
  if (!status || readinessScore === undefined || !summary || !reasoning) {
    return undefined;
  }

  return {
    status,
    readinessScore,
    summary,
    ...(normalizeString(payload.rewrittenTitle)
      ? { rewrittenTitle: normalizeString(payload.rewrittenTitle) }
      : {}),
    ...(normalizeString(payload.rewrittenDescription)
      ? { rewrittenDescription: normalizeString(payload.rewrittenDescription) }
      : {}),
    acceptanceCriteria: normalizeStringArray(payload.acceptanceCriteria),
    clarificationQuestions: normalizeStringArray(payload.clarificationQuestions),
    decompositionHints: normalizeStringArray(payload.decompositionHints),
    riskFactors: normalizeStringArray(payload.riskFactors),
    reasoning,
  };
};

export const parseTaskIntakeReviewDecision = (
  message: string | undefined,
): TaskIntakeReviewDecision | undefined => {
  if (!message) {
    return undefined;
  }

  const payload = extractPayload(message);
  return payload ? normalizeTaskIntakeReviewDecision(payload) : undefined;
};

const normalizeQuestionLimit = (maxQuestions: number): number =>
  Number.isInteger(maxQuestions) && maxQuestions > 0 ? maxQuestions : 1;

export const limitTaskIntakeReviewQuestions = (
  decision: TaskIntakeReviewDecision,
  maxQuestions: number,
): TaskIntakeReviewDecision => ({
  ...decision,
  clarificationQuestions: decision.clarificationQuestions.slice(
    0,
    normalizeQuestionLimit(maxQuestions),
  ),
});

export const createTaskIntakeFingerprint = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
): string => {
  const humanComments = comments
    .filter((comment) => !comment.metadata && !comment.isSystem)
    .map((comment) => ({
      id: comment.id,
      text: comment.text.trim(),
      createdAt: comment.createdAt,
      author: comment.author,
    }));

  const payload = JSON.stringify({
    title: issue.title,
    description: issue.description,
    queue: issue.queue,
    tags: issue.tags ?? [],
    priority: issue.priority,
    deadline: issue.deadline,
    components: issue.components ?? [],
    humanComments,
  });

  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
};
```

- [ ] **Step 5: Run the focused test**

Run: `npx vitest run tests/taskIntakeReview.test.ts`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/models/types.ts src/domain/taskIntakeReview.ts tests/taskIntakeReview.test.ts
git commit -m "feat: add task intake review decision parser"
```

## Task 2: Structured Tracker Comment Protocol

**Files:**
- Modify: `src/models/types.ts`
- Modify: `src/integrations/tracker/commentProtocol.ts`
- Test: `tests/commentProtocol.test.ts`

- [ ] **Step 1: Write failing comment protocol tests**

Append to `tests/commentProtocol.test.ts`:

```ts
it("formats, parses, and finds latest AI TASK REVIEW comments", () => {
  const first = formatTaskIntakeReviewComment(
    "worker-1",
    "DEV-1",
    {
      status: "needs_clarification",
      readinessScore: 35,
      summary: "Task is missing target workflow details.",
      rewrittenTitle: "Clarify broken form behavior",
      rewrittenDescription: "Known facts are insufficient for a safe rewrite.",
      acceptanceCriteria: [],
      clarificationQuestions: ["Which form is affected?", "What behavior is expected?"],
      decompositionHints: [],
      riskFactors: ["The screen is unknown."],
      reasoning: "The original task only says that a form is broken.",
    },
    "fingerprint-1",
  );
  const second = formatTaskIntakeReviewComment(
    "worker-1",
    "DEV-1",
    {
      status: "ready",
      readinessScore: 82,
      summary: "Task now has a target workflow and acceptance criteria.",
      acceptanceCriteria: ["Saving the profile form persists the new name."],
      clarificationQuestions: [],
      decompositionHints: [],
      riskFactors: [],
      reasoning: "The latest human reply identified the affected form and expected behavior.",
    },
    "fingerprint-2",
  );

  expect(parseServiceComment(first)).toMatchObject({
    kind: "AI TASK REVIEW",
    worker: "worker-1",
    issueKey: "DEV-1",
    reviewStatus: "needs_clarification",
    readinessScore: 35,
    sourceFingerprint: "fingerprint-1",
    clarificationQuestions: ["Which form is affected?", "What behavior is expected?"],
  });

  const comments: CommentWithMetadata[] = [
    {
      id: "1",
      text: first,
      createdAt: "2026-06-09T06:00:00.000Z",
      isSystem: false,
      metadata: parseServiceComment(first),
    },
    {
      id: "2",
      text: second,
      createdAt: "2026-06-09T06:05:00.000Z",
      isSystem: false,
      metadata: parseServiceComment(second),
    },
  ];

  expect(findLatestTaskIntakeReview(comments, "DEV-1")).toMatchObject({
    reviewStatus: "ready",
    sourceFingerprint: "fingerprint-2",
  });
});
```

Update the import list in the same file:

```ts
  findLatestTaskIntakeReview,
  formatTaskIntakeReviewComment,
```

- [ ] **Step 2: Run the protocol test and verify it fails**

Run: `npx vitest run tests/commentProtocol.test.ts`

Expected: fail because `formatTaskIntakeReviewComment` and `findLatestTaskIntakeReview` are not exported.

- [ ] **Step 3: Extend parsed comment types**

In `src/models/types.ts`, add `"AI TASK REVIEW"` to `ServiceCommentKind`.

Add these optional fields to `ParsedServiceComment`:

```ts
  reviewStatus?: TaskIntakeReviewStatus;
  readinessScore?: number;
  rewrittenTitle?: string;
  rewrittenDescription?: string;
  acceptanceCriteria?: string[];
  clarificationQuestions?: string[];
  decompositionHints?: string[];
  sourceFingerprint?: string;
```

- [ ] **Step 4: Implement structured comment support**

In `src/integrations/tracker/commentProtocol.ts`, import the new decision type:

```ts
  TaskIntakeReviewDecision,
```

Add the prefix:

```ts
const TASK_REVIEW_PREFIX = "AI TASK REVIEW:";
```

Add parsing inside `parseStructuredServiceComment()` after the `AI ANALYSIS` branch:

```ts
    if (kind === "AI TASK REVIEW") {
      const issueKey = normalizeString(jsonPayload.issueKey);
      const reviewStatus = normalizeString(jsonPayload.status);
      const readinessScore = normalizeNumber(jsonPayload.readinessScore);
      const sourceFingerprint = normalizeString(jsonPayload.sourceFingerprint);
      if (
        !issueKey ||
        !sourceFingerprint ||
        readinessScore === undefined ||
        readinessScore < 0 ||
        readinessScore > 100 ||
        !(
          reviewStatus === "ready" ||
          reviewStatus === "needs_clarification" ||
          reviewStatus === "needs_decomposition" ||
          reviewStatus === "reject_as_invalid"
        )
      ) {
        return undefined;
      }

      return {
        kind,
        worker,
        issueKey,
        reviewStatus,
        readinessScore,
        sourceFingerprint,
        summary: normalizeString(jsonPayload.summary),
        rewrittenTitle: normalizeString(jsonPayload.rewrittenTitle),
        rewrittenDescription: normalizeString(jsonPayload.rewrittenDescription),
        acceptanceCriteria: normalizeStringArray(jsonPayload.acceptanceCriteria) ?? [],
        clarificationQuestions: normalizeStringArray(jsonPayload.clarificationQuestions) ?? [],
        decompositionHints: normalizeStringArray(jsonPayload.decompositionHints) ?? [],
        riskFactors: normalizeStringArray(jsonPayload.riskFactors) ?? [],
        reasoning: normalizeString(jsonPayload.reasoning),
      };
    }
```

Add formatter before `formatDecompositionComment()`:

```ts
export const formatTaskIntakeReviewComment = (
  worker: string,
  issueKey: string,
  decision: TaskIntakeReviewDecision,
  sourceFingerprint: string,
): string =>
  buildStructuredComment(
    TASK_REVIEW_PREFIX,
    {
      worker,
      issueKey,
      status: decision.status,
      readinessScore: decision.readinessScore,
      sourceFingerprint,
      summary: decision.summary,
      ...(decision.rewrittenTitle ? { rewrittenTitle: decision.rewrittenTitle } : {}),
      ...(decision.rewrittenDescription
        ? { rewrittenDescription: decision.rewrittenDescription }
        : {}),
      acceptanceCriteria: decision.acceptanceCriteria,
      clarificationQuestions: decision.clarificationQuestions,
      decompositionHints: decision.decompositionHints,
      riskFactors: decision.riskFactors,
      reasoning: decision.reasoning,
    },
    [
      `Task intake review: ${decision.status}`,
      `Readiness score: ${decision.readinessScore}`,
      "",
      decision.summary,
      decision.rewrittenTitle ? `Suggested title: ${decision.rewrittenTitle}` : "",
      decision.rewrittenDescription
        ? ["", "Suggested description:", decision.rewrittenDescription].join("\n")
        : "",
      decision.acceptanceCriteria.length > 0
        ? ["", "Acceptance criteria:", ...decision.acceptanceCriteria.map((entry) => `- ${entry}`)].join("\n")
        : "",
      decision.clarificationQuestions.length > 0
        ? ["", "Questions for the task author:", ...decision.clarificationQuestions.map((entry) => `- ${entry}`)].join("\n")
        : "",
      decision.decompositionHints.length > 0
        ? ["", "Decomposition hints:", ...decision.decompositionHints.map((entry) => `- ${entry}`)].join("\n")
        : "",
      decision.riskFactors.length > 0
        ? ["", "Risk factors:", ...decision.riskFactors.map((entry) => `- ${entry}`)].join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
```

Add to `parseServiceComment()` chain before `AI DECOMPOSITION`:

```ts
  parseStructuredServiceComment(TASK_REVIEW_PREFIX, "AI TASK REVIEW", text) ??
```

Add latest lookup near `findLatestAnalysisDecision()`:

```ts
export const findLatestTaskIntakeReview = (
  comments: CommentWithMetadata[],
  issueKey?: string,
): ParsedServiceComment | undefined =>
  comments
    .filter(
      (comment): comment is CommentWithMetadata & { metadata: ParsedServiceComment } =>
        comment.metadata?.kind === "AI TASK REVIEW" &&
        (issueKey === undefined || comment.metadata.issueKey === issueKey),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.metadata;
```

- [ ] **Step 5: Run focused protocol tests**

Run: `npx vitest run tests/commentProtocol.test.ts`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/models/types.ts src/integrations/tracker/commentProtocol.ts tests/commentProtocol.test.ts
git commit -m "feat: add task intake review comments"
```

## Task 3: Codex Prompt Contract

**Files:**
- Modify: `src/domain/promptBuilder.ts`
- Test: `tests/promptBuilder.test.ts`

- [ ] **Step 1: Write a failing prompt test**

Append to `tests/promptBuilder.test.ts`:

```ts
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
  expect(prompt).toContain('"clarificationQuestions"');
  expect(prompt).toContain("at most 4 clarification questions");
});
```

Update the import from `../src/domain/promptBuilder.js` to include:

```ts
  buildTaskIntakeReviewPrompt,
```

- [ ] **Step 2: Run the prompt test and verify it fails**

Run: `npx vitest run tests/promptBuilder.test.ts`

Expected: fail because `buildTaskIntakeReviewPrompt` is not exported.

- [ ] **Step 3: Implement the prompt builder**

In `src/domain/promptBuilder.ts`, add this export after `buildAnalysisPrompt()`:

```ts
export const buildTaskIntakeReviewPrompt = (
  issue: TrackerIssue,
  comments: CommentWithMetadata[],
  memoryContext?: PromptContextBundle,
  imageContext?: PromptImageContext,
  maxQuestions = 5,
): string => `Task: ${issue.key}
Title: ${issue.title}

Description:
${issue.description || "No description."}

Additional context:
${formatHumanComments(comments)}
${formatRepositoryContext(memoryContext)}${formatImageContext(imageContext)}

Mode: task-intake-review

Requirements:
1. Review the task specification quality only.
2. Do not modify files, do not create files, do not run commands, and do not perform implementation work.
3. Decide whether the task is ready for development, needs clarification, needs decomposition, or is invalid for an AI development worker.
4. Do not invent missing business requirements. If information is missing, ask for it explicitly.
5. When suggesting a rewritten title or description, preserve only facts present in the task, human comments, attachments, or repository context.
6. Ask at most ${maxQuestions} clarification questions.
7. Reply with exactly one line that starts with AI_TASK_REVIEW: followed by one compact JSON object.
8. Do not add markdown fences, explanations, or any extra text around that one-line response.

Required JSON schema:
{
  "status": "needs_clarification",
  "readinessScore": 35,
  "summary": "The task lacks observable acceptance criteria.",
  "rewrittenTitle": "Clarify form submission failure",
  "rewrittenDescription": "Only include known facts; state that missing facts must be answered by the author.",
  "acceptanceCriteria": ["The expected user-visible behavior is verified."],
  "clarificationQuestions": ["Which screen or workflow is affected?"],
  "decompositionHints": [],
  "riskFactors": ["The affected subsystem is unclear."],
  "reasoning": "The task describes a symptom but not the expected behavior."
}

Allowed status values:
- ready
- needs_clarification
- needs_decomposition
- reject_as_invalid`;
```

- [ ] **Step 4: Run focused prompt tests**

Run: `npx vitest run tests/promptBuilder.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/promptBuilder.ts tests/promptBuilder.test.ts
git commit -m "feat: add task intake review prompt"
```

## Task 4: Worker Orchestration Path

**Files:**
- Modify: `src/domain/orchestrator.ts`
- Modify: `src/observability/events.ts`
- Modify: `tests/orchestrator.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

In `tests/orchestrator.test.ts`, update `FakeTrackerClient` to record candidate lookup input:

```ts
  readonly candidateInputs: Array<{ queue?: string; tag?: string; issueKey?: string } | undefined> = [];

  async findCandidateIssues(input?: {
    queue?: string;
    tag?: string;
    issueKey?: string;
  }): Promise<TrackerIssue[]> {
    this.candidateIssueLookups += 1;
    this.candidateInputs.push(input);
    const tag = input?.tag;
    return tag
      ? this.issues.filter((issue) => issue.tags?.includes(tag))
      : this.issues;
  }
```

Add this test:

```ts
it("runs intake review for ai_task_analysis tasks without starting implementation", async () => {
  const tracker = new FakeTrackerClient(
    [
      {
        id: "1",
        key: "DEV-INTAKE",
        title: "Сделать нормально",
        description: "Плохо работает форма",
        queue: "DEV",
        tags: ["ai_task_analysis"],
        createdAt: "2026-06-09T06:00:00.000Z",
        logicalStatus: "open",
      },
    ],
    { "DEV-INTAKE": [] },
  );
  const git = new FakeGitService();
  const codex = new FakeCodexRunner([
    () => ({
      process: { stdout: "", stderr: "", exitCode: 0 },
      finalMessage:
        'AI_TASK_REVIEW: {"status":"needs_clarification","readinessScore":30,"summary":"The target workflow is missing.","rewrittenTitle":"Clarify broken form behavior","rewrittenDescription":"Known facts are insufficient for a safe rewrite.","acceptanceCriteria":[],"clarificationQuestions":["Which form is affected?","What should happen instead?","How can it be reproduced?"],"decompositionHints":[],"riskFactors":["The affected form is unknown."],"reasoning":"The task does not identify the screen or expected behavior."}',
      threadId: "thread-intake",
    }),
  ]);
  const orchestrator = new WorkerOrchestrator(
    createConfig(process.cwd(), {
      taskIntakeReview: {
        enabled: true,
        tag: "ai_task_analysis",
        maxQuestions: 2,
      },
    }),
    tracker,
    git,
    new FakeGitLabService(),
    codex,
    new Logger(),
  );

  const outcome = await orchestrator.runOnce();

  expect(outcome).toBe("processed");
  expect(tracker.candidateInputs[0]).toMatchObject({ tag: "ai_task_analysis" });
  expect(tracker.transitions).toEqual([]);
  expect(git.currentBranch).toBe("main");
  expect(codex.resumeCalls).toEqual([]);
  const reviewComment = tracker.addedComments.find((entry) =>
    entry.text.startsWith("AI TASK REVIEW:"),
  );
  expect(reviewComment).toBeDefined();
  expect(parseServiceComment(reviewComment!.text)).toMatchObject({
    clarificationQuestions: ["Which form is affected?", "What should happen instead?"],
  });
});
```

Add this owned-task priority test:

```ts
it("resumes owned tasks before scanning intake review candidates", async () => {
  const ownedStatusText = formatStatusComment(
    "worker-1",
    "in_progress",
    "Started processing task.",
  );
  const tracker = new FakeTrackerClient(
    [
      {
        id: "1",
        key: "DEV-OWNED",
        title: "Continue owned work",
        description: "Already picked by this worker.",
        queue: "DEV",
        tags: ["ai_dev"],
        logicalStatus: "in_progress",
      },
      {
        id: "2",
        key: "DEV-INTAKE",
        title: "Проверить задачу",
        description: "Неясная постановка",
        queue: "DEV",
        tags: ["ai_task_analysis"],
        logicalStatus: "open",
      },
    ],
    {
      "DEV-OWNED": [
        {
          id: "1",
          text: ownedStatusText,
          createdAt: "2026-06-09T06:00:00.000Z",
          isSystem: false,
          metadata: parseServiceComment(ownedStatusText),
        },
      ],
      "DEV-INTAKE": [],
    },
  );
  const codex = new FakeCodexRunner([
    () => ({
      process: { stdout: "", stderr: "", exitCode: 0 },
      finalMessage: "READY_FOR_IMPLEMENTATION",
      threadId: "thread-owned-analysis",
    }),
  ]);
  const orchestrator = new WorkerOrchestrator(
    createConfig(process.cwd(), {
      taskMode: "analyze_only",
      taskIntakeReview: {
        enabled: true,
        tag: "ai_task_analysis",
        maxQuestions: 5,
      },
    }),
    tracker,
    new FakeGitService(),
    new FakeGitLabService(),
    codex,
    new Logger(),
  );

  const outcome = await orchestrator.runOnce();

  expect(outcome).toBe("processed");
  expect(tracker.candidateInputs).toEqual([]);
  expect(codex.initialCalls).toHaveLength(1);
  expect(codex.initialCalls[0]?.prompt).toContain("AI_ANALYSIS:");
  expect(
    tracker.addedComments.some((entry) => entry.text.startsWith("AI TASK REVIEW:")),
  ).toBe(false);
});
```

Add this idempotency test:

```ts
it("skips intake review when the latest review matches the current fingerprint", async () => {
  const issue: TrackerIssue = {
    id: "1",
    key: "DEV-INTAKE-SKIP",
    title: "Проверить задачу",
    description: "Неясная постановка",
    queue: "DEV",
    tags: ["ai_task_analysis"],
    createdAt: "2026-06-09T06:00:00.000Z",
    logicalStatus: "open",
  };
  const comments: CommentWithMetadata[] = [];
  const fingerprint = createTaskIntakeFingerprint(issue, comments);
  const reviewText = formatTaskIntakeReviewComment(
    "worker-1",
    issue.key,
    {
      status: "needs_clarification",
      readinessScore: 20,
      summary: "Task is unclear.",
      acceptanceCriteria: [],
      clarificationQuestions: ["What should be changed?"],
      decompositionHints: [],
      riskFactors: [],
      reasoning: "The task has no expected behavior.",
    },
    fingerprint,
  );
  comments.push({
    id: "1",
    text: reviewText,
    createdAt: "2026-06-09T06:01:00.000Z",
    isSystem: false,
    metadata: parseServiceComment(reviewText),
  });

  const tracker = new FakeTrackerClient([issue], { [issue.key]: comments });
  const codex = new FakeCodexRunner([]);
  const orchestrator = new WorkerOrchestrator(
    createConfig(process.cwd(), {
      taskIntakeReview: {
        enabled: true,
        tag: "ai_task_analysis",
        maxQuestions: 5,
      },
    }),
    tracker,
    new FakeGitService(),
    new FakeGitLabService(),
    codex,
    new Logger(),
  );

  const outcome = await orchestrator.runOnce();

  expect(outcome).toBe("idle");
  expect(codex.initialCalls).toEqual([]);
  expect(tracker.addedComments).toEqual([]);
});
```

Update imports in `tests/orchestrator.test.ts`:

```ts
  findLatestTaskIntakeReview,
  formatTaskIntakeReviewComment,
```

and:

```ts
import { createTaskIntakeFingerprint } from "../src/domain/taskIntakeReview.js";
```

- [ ] **Step 2: Run the orchestration tests and verify they fail**

Run: `npx vitest run tests/orchestrator.test.ts -t "intake review"`

Expected: fail because `WorkerOrchestrator` does not scan `taskIntakeReview`.

- [ ] **Step 3: Add imports in orchestrator**

In `src/domain/orchestrator.ts`, extend imports:

```ts
  findLatestTaskIntakeReview,
  formatTaskIntakeReviewComment,
```

```ts
  buildTaskIntakeReviewPrompt,
```

```ts
import {
  createTaskIntakeFingerprint,
  limitTaskIntakeReviewQuestions,
  parseTaskIntakeReviewDecision,
} from "./taskIntakeReview.js";
```

- [ ] **Step 4: Add intake telemetry event types and Codex stage typing**

In `src/observability/events.ts`, add these members to `TaskEventType` near the other Codex stage events:

```ts
  | "task_intake_review_started"
  | "task_intake_review_completed"
```

In `src/domain/orchestrator.ts`, extend the `runCodexStage()` `stage` union:

```ts
    stage:
      | "analysis"
      | "implementation"
      | "decomposition"
      | "review_fix"
      | "self_review"
      | "task_intake_review",
```

- [ ] **Step 5: Route intake review after owned work and before new implementation work**

In `runOnce()`, keep the `targetIssueKey` branch first and keep the `resumeOwnedTask()` block before intake review. After the owned-task block and before `const nextTask = await this.pickNextTask();`, add:

```ts
    if (this.config.taskIntakeReview?.enabled) {
      const intakeOutcome = await this.runTaskIntakeReviewOnce();
      if (intakeOutcome !== "idle") {
        return intakeOutcome;
      }
    }
```

- [ ] **Step 6: Implement intake candidate selection**

Add this method near `pickNextTask()`:

```ts
  private async pickTaskIntakeReviewCandidate(): Promise<{
    issue: TrackerIssue;
    comments: CommentWithMetadata[];
    fingerprint: string;
  } | null> {
    const reviewConfig = this.config.taskIntakeReview;
    if (!reviewConfig?.enabled) {
      return null;
    }

    const issues = await this.tracker.findCandidateIssues({
      queue: this.config.trackerDefaultQueue,
      tag: reviewConfig.tag,
    });

    for (const issue of issues.filter((entry) => entry.logicalStatus === "open")) {
      const comments = await this.tracker.getComments(issue.key);
      const fingerprint = createTaskIntakeFingerprint(issue, comments);
      const latestReview = findLatestTaskIntakeReview(comments, issue.key);
      if (latestReview?.sourceFingerprint === fingerprint) {
        this.logger.info("Skipping task intake review because the latest review is current.", {
          issueKey: issue.key,
          fingerprint,
          latestReviewWorker: latestReview.worker,
        });
        continue;
      }

      return { issue, comments, fingerprint };
    }

    return null;
  }
```

- [ ] **Step 7: Implement task-only intake lease**

Add this method near `acquireProcessingLeases()`:

```ts
  private async acquireTaskIntakeReviewLease(issue: TrackerIssue): Promise<TaskLease[] | null> {
    if (!this.lockBackend || !this.coordination) {
      return [];
    }

    const repositoryName = "repositoryName" in this.config
      ? String(this.config.repositoryName)
      : "default";
    const taskLease = await this.lockBackend.acquireTaskLease({
      issueKey: issue.key,
      workerId: this.config.workerId,
      repositoryName,
      repoPath: this.config.repoPath,
      ttlMs: this.coordination.lockTtlMs,
    });
    if (!taskLease) {
      this.logger.info("Task intake review is already leased by another worker.", {
        issueKey: issue.key,
      });
      return null;
    }

    return [taskLease];
  }
```

- [ ] **Step 8: Implement the review cycle**

Add this method near `runTargetIssueCycle()`:

```ts
  private async runTaskIntakeReviewOnce(): Promise<CycleOutcome> {
    const selected = await this.pickTaskIntakeReviewCandidate();
    if (!selected) {
      return "idle";
    }

    const leases = await this.acquireTaskIntakeReviewLease(selected.issue);
    if (!leases) {
      return "waiting";
    }

    const run = async (): Promise<CycleOutcome> => {
      const imageContext = await prepareTrackerImageContext({
        issueKey: selected.issue.key,
        tracker: this.tracker,
        config: this.config.trackerImageContext ?? DEFAULT_TRACKER_IMAGE_CONTEXT_CONFIG,
        logger: this.logger,
      });

      try {
        const memoryContext = await this.buildMemoryContext({
          issue: selected.issue,
          taskType: "unknown",
          promptProfileId: "general",
          expectedFiles: [],
        });
        const maxQuestions = this.config.taskIntakeReview?.maxQuestions ?? 5;
        const execution = await this.runCodexStage(selected.issue, "task_intake_review", () =>
          this.codex.runInitial(
            buildTaskIntakeReviewPrompt(
              selected.issue,
              selected.comments,
              memoryContext,
              imageContext,
              maxQuestions,
            ),
            undefined,
            { imagePaths: imageContext.imagePaths },
          ),
        );
        const parsedDecision = parseTaskIntakeReviewDecision(execution.finalMessage);
        const decision = limitTaskIntakeReviewQuestions(
          parsedDecision ?? {
            status: "needs_clarification",
            readinessScore: 0,
            summary: "Task intake review did not return valid structured output.",
            acceptanceCriteria: [],
            clarificationQuestions: [
              "Please clarify the task goal, expected behavior, and acceptance criteria.",
            ],
            decompositionHints: [],
            riskFactors: [execution.process.stderr.trim() || "Invalid AI_TASK_REVIEW output."],
            reasoning:
              execution.finalMessage?.trim() ||
              execution.process.stderr.trim() ||
              "Codex returned an empty task intake review response.",
          },
          maxQuestions,
        );

        await this.tracker.addComment(
          selected.issue.key,
          formatTaskIntakeReviewComment(
            this.config.workerId,
            selected.issue.key,
            decision,
            selected.fingerprint,
          ),
        );
        return "processed";
      } finally {
        await imageContext.cleanup();
      }
    };

    if (this.lockBackend && leases.length > 0) {
      return withLeaseHeartbeat(
        this.lockBackend,
        leases,
        this.coordination?.lockHeartbeatMs ?? 60 * 1000,
        run,
      );
    }

    return run();
  }
```

- [ ] **Step 9: Run focused orchestration tests**

Run: `npx vitest run tests/orchestrator.test.ts -t "intake review"`

Expected: pass.

- [ ] **Step 10: Run all orchestrator tests**

Run: `npx vitest run tests/orchestrator.test.ts`

Expected: pass.

- [ ] **Step 11: Commit**

```bash
git add src/domain/orchestrator.ts src/observability/events.ts tests/orchestrator.test.ts
git commit -m "feat: review intake-tagged tracker tasks"
```

## Task 5: Configuration

**Files:**
- Modify: `src/config.ts`
- Modify: `src/models/types.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing config tests**

In `tests/config.test.ts`, add expectations to the `"applies defaults"` test:

```ts
    expect(config.taskIntakeReview).toEqual({
      enabled: false,
      tag: "ai_task_analysis",
      maxQuestions: 5,
    });
```

Add a dedicated env parsing test:

```ts
it("parses task intake review settings", () => {
  const env = {
    TRACKER_TOKEN: "tracker-token",
    TRACKER_ORG_ID: "org-id",
    TRACKER_STATUS_MAP_FILE: createStatusMapFile(),
    GITLAB_URL: "https://gitlab.example.com/",
    GITLAB_TOKEN: "gitlab-token",
    GITLAB_PROJECT_ID: "123",
    MAX_FIX_ATTEMPTS: "2",
    WORKER_ID: "worker-1",
    TASK_INTAKE_REVIEW_ENABLED: "true",
    TASK_INTAKE_REVIEW_TAG: "needs_ai_review",
    TASK_INTAKE_REVIEW_MAX_QUESTIONS: "3",
  };

  const config = loadConfig(env);
  const fleetConfig = loadFleetConfig(env);
  const runtimeConfig = buildRepositoryRuntimeConfig(
    fleetConfig,
    fleetConfig.repositories[0]!,
  );

  expect(config.taskIntakeReview).toEqual({
    enabled: true,
    tag: "needs_ai_review",
    maxQuestions: 3,
  });
  expect(fleetConfig.taskIntakeReview).toEqual(config.taskIntakeReview);
  expect(runtimeConfig.taskIntakeReview).toEqual(config.taskIntakeReview);
});
```

- [ ] **Step 2: Run config tests and verify they fail**

Run: `npx vitest run tests/config.test.ts -t "task intake review|applies defaults"`

Expected: fail because `taskIntakeReview` is missing.

- [ ] **Step 3: Add defaults and parser**

In `src/config.ts`, add near other defaults:

```ts
const DEFAULT_TASK_INTAKE_REVIEW_CONFIG: TaskIntakeReviewConfig = {
  enabled: false,
  tag: "ai_task_analysis",
  maxQuestions: 5,
};
```

Add `TaskIntakeReviewConfig` to the type imports from `./models/types.js`.

Add parser helper near other config helpers:

```ts
const parseTaskIntakeReviewConfig = (
  env: NodeJS.ProcessEnv,
  rawValue?: unknown,
): TaskIntakeReviewConfig => {
  const configured = typeof rawValue === "object" && rawValue !== null
    ? (rawValue as Record<string, unknown>)
    : {};

  return {
    enabled: env.TASK_INTAKE_REVIEW_ENABLED?.trim()
      ? parseBooleanFlag(
          env.TASK_INTAKE_REVIEW_ENABLED,
          "TASK_INTAKE_REVIEW_ENABLED",
          DEFAULT_TASK_INTAKE_REVIEW_CONFIG.enabled,
        )
      : optionalBoolean(
          configured.enabled,
          "taskIntakeReview.enabled",
          DEFAULT_TASK_INTAKE_REVIEW_CONFIG.enabled,
        ),
    tag:
      env.TASK_INTAKE_REVIEW_TAG?.trim() ||
      optionalString(
        configured.tag,
        "taskIntakeReview.tag",
      ) ||
      DEFAULT_TASK_INTAKE_REVIEW_CONFIG.tag,
    maxQuestions: env.TASK_INTAKE_REVIEW_MAX_QUESTIONS?.trim()
      ? parsePositiveIntAtMost(
          env.TASK_INTAKE_REVIEW_MAX_QUESTIONS,
          "TASK_INTAKE_REVIEW_MAX_QUESTIONS",
          10,
        )
      : assertPositiveIntAtMost(
          optionalNumber(
            configured.maxQuestions,
            "taskIntakeReview.maxQuestions",
            DEFAULT_TASK_INTAKE_REVIEW_CONFIG.maxQuestions,
          ),
          "taskIntakeReview.maxQuestions",
          10,
        ),
  };
};
```

- [ ] **Step 4: Wire single-repository and fleet config**

In `loadConfig()`, add:

```ts
    taskIntakeReview: parseTaskIntakeReviewConfig(env),
```

In `buildSingleRepositoryFleetConfig()`, add:

```ts
    taskIntakeReview: config.taskIntakeReview,
```

In `loadFleetConfigFromFile()`, parse the root setting:

```ts
  const taskIntakeReview = parseTaskIntakeReviewConfig(env, root.taskIntakeReview);
```

and include it in the returned `GlobalWorkerConfig`:

```ts
    taskIntakeReview,
```

In `buildRepositoryRuntimeConfig()`, add:

```ts
  taskIntakeReview: globalConfig.taskIntakeReview,
```

- [ ] **Step 5: Run focused config tests**

Run: `npx vitest run tests/config.test.ts -t "task intake review|applies defaults"`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/models/types.ts tests/config.test.ts
git commit -m "feat: configure task intake review mode"
```

## Task 6: Documentation And Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ENV_CONFIGURATION.md`

- [ ] **Step 1: Document the mode in README**

In `README.md`, under `## Режимы работы`, add:

```md
### Предварительная проверка постановки задач

`TASK_INTAKE_REVIEW_ENABLED=true` включает отдельный intake-режим для задач с тегом `ai_task_analysis`. В этом режиме воркер проверяет качество постановки задачи и пишет комментарий `AI TASK REVIEW:` с одним из результатов:

- `ready` - постановка достаточно понятна для разработки.
- `needs_clarification` - автору нужно ответить на конкретные вопросы.
- `needs_decomposition` - задача слишком крупная для одного изменения.
- `reject_as_invalid` - задача не подходит для AI-разработчика в текущем виде.

Первый релиз работает только через комментарии: воркер не меняет описание задачи, не добавляет `ai_dev`, не переводит статус, не создает ветку и не открывает merge request.
```

- [ ] **Step 2: Document env vars**

In `docs/ENV_CONFIGURATION.md`, add rows near `TASK_MODE`:

```md
| `TASK_INTAKE_REVIEW_ENABLED` | Нет | `false` | Включает предварительную проверку постановки задач. Когда включено, воркер сначала ищет открытые задачи с `TASK_INTAKE_REVIEW_TAG` и пишет structured comment `AI TASK REVIEW:` без запуска реализации. |
| `TASK_INTAKE_REVIEW_TAG` | Нет | `ai_task_analysis` | Тег Yandex Tracker задач, которые нужно проверить на полноту постановки до добавления в обычный `ai_dev` flow. |
| `TASK_INTAKE_REVIEW_MAX_QUESTIONS` | Нет | `5` | Максимальное количество вопросов к автору задачи в одном `AI TASK REVIEW:` комментарии. Допустимые значения: 1-10. |
```

Add a short operational note:

```md
## Предварительная проверка постановки

Этот режим предназначен для intake очереди. Он не заменяет `TASK_MODE=analyze_only`: `analyze_only` применяется уже внутри dev-flow, а `TASK_INTAKE_REVIEW_ENABLED` проверяет задачи до начала работы. Повторный комментарий не создается, если учитываемые входные данные задачи не изменились после последнего `AI TASK REVIEW:`: заголовок, описание, очередь, теги, приоритет, дедлайн, компоненты и человеческие комментарии.
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
npx vitest run tests/taskIntakeReview.test.ts tests/commentProtocol.test.ts tests/promptBuilder.test.ts tests/orchestrator.test.ts tests/config.test.ts
```

Expected: all listed test files pass.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: TypeScript exits successfully.

- [ ] **Step 5: Run full tests**

Run: `npm test`

Expected: Vitest suite passes.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/ENV_CONFIGURATION.md
git commit -m "docs: document task intake review mode"
```

## Self-Review

- Spec coverage: The plan covers opt-in tag scanning, owned-task priority, Codex task review, structured Tracker comments, cross-worker fingerprint idempotency, max-question enforcement, no status transitions, no branch creation, config, docs, and verification.
- Scope control: Automatic Tracker description editing and automatic tag mutation are intentionally excluded from this first release. A later release can add a guarded apply mode after the comment-only flow is stable.
- Type consistency: The same names are used across tasks: `TaskIntakeReviewDecision`, `TaskIntakeReviewStatus`, `TaskIntakeReviewConfig`, `buildTaskIntakeReviewPrompt`, `parseTaskIntakeReviewDecision`, `limitTaskIntakeReviewQuestions`, `createTaskIntakeFingerprint`, `formatTaskIntakeReviewComment`, and `findLatestTaskIntakeReview`.
- Red-flag scan: No incomplete sections, deferred implementation markers, or unspecified test commands remain.
