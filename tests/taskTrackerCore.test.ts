import { describe, expect, it } from "vitest";

import {
  FIELD_OWNERSHIP_RULES,
  AgentWorkflowService,
  FieldOwnershipError,
  InMemoryTaskTrackerClient,
  InvalidTaskStatusTransitionError,
  TASK_STATUS_TO_LOGICAL_STATUS,
  canOwnerUpdateFieldGroup,
  mapTaskStatusToLogicalStatus,
} from "../src/domain/taskTracker/index.js";
import type {
  CreateTaskInput,
  ExternalTaskSource,
  TaskActor,
} from "../src/domain/taskTracker/index.js";

const human: TaskActor = {
  owner: "human",
  id: "user-1",
  displayName: "User One",
};

const worker: TaskActor = {
  owner: "worker_agent",
  id: "worker-1",
  displayName: "Worker One",
};

const external: TaskActor = {
  owner: "external_source",
  id: "external-tracker",
};

const createClock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 3, 28, 10, tick++, 0));
};

const baseTaskInput = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  title: "Implement internal tracker",
  description: "Create the Phase 7A task tracker core.",
  createdBy: human,
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: ["ai_dev"],
  components: ["worker"],
  taskType: "backend_endpoint",
  promptProfileId: "general",
  acceptanceCriteria: ["Task can be created internally."],
  constraints: ["Do not touch Yandex direct mode."],
  ...overrides,
});

describe("internal task tracker core", () => {
  it("creates a native task with required fields and no external tracker issue", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });

    const task = await client.createTask(baseTaskInput());

    expect(task.source).toEqual({ kind: "native" });
    expect(task.status).toBe("new");
    expect(task.externalRefs).toEqual([]);
    expect(task.revisions).toHaveLength(1);
    expect(task.revisions[0]).toMatchObject({
      revisionNumber: 1,
      title: "Implement internal tracker",
      owner: "human",
    });
  });

  it("creates a task in triage when required execution fields are missing", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });

    const task = await client.createTask(
      baseTaskInput({
        repositoryName: undefined,
        repoPathKey: undefined,
      }),
    );

    expect(task.status).toBe("triage");
  });

  it("marks a task ready through status transition validation", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });
    const task = await client.createTask(baseTaskInput());

    await client.markReady(task.id, "All execution fields are present.");

    const updated = await client.getTask(task.id);
    expect(updated.status).toBe("ready");
    expect(updated.events.at(-1)).toMatchObject({
      kind: "task_status_changed",
      payload: { from: "new", to: "ready" },
    });
  });

  it("rejects invalid status transitions", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });
    const task = await client.createTask(baseTaskInput());

    await expect(client.setStatus(task.id, "implementing")).rejects.toThrow(
      InvalidTaskStatusTransitionError,
    );
  });

  it("records a new task revision while preserving previous input", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });
    const task = await client.createTask(baseTaskInput());

    const updated = await client.updateTaskRevision(task.id, {
      owner: "external_source",
      author: external,
      title: "Implement internal tracker core",
      description: "Updated external description.",
      externalRevisionId: "ext-rev-2",
      externalSnapshot: { status: "Open", key: "DEV-7" },
      reason: "External issue changed.",
    });

    expect(updated.title).toBe("Implement internal tracker core");
    expect(updated.revisions).toHaveLength(2);
    expect(updated.revisions[0]).toMatchObject({
      revisionNumber: 1,
      title: "Implement internal tracker",
    });
    expect(updated.revisions[1]).toMatchObject({
      revisionNumber: 2,
      owner: "external_source",
      externalRevisionId: "ext-rev-2",
    });
    expect(updated.status).toBe("new");
  });

  it("appends events without replacing earlier timeline entries", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });
    const task = await client.createTask(baseTaskInput());

    await client.appendEvent(task.id, {
      kind: "custom_first",
      source: "worker_agent",
      message: "First event.",
      createdAt: "2026-04-28T10:10:00.000Z",
    });
    await client.appendEvent(task.id, {
      kind: "custom_second",
      source: "worker_agent",
      message: "Second event.",
      createdAt: "2026-04-28T10:11:00.000Z",
    });

    const customEvents = (await client.getTask(task.id)).events.filter((event) =>
      event.kind.startsWith("custom_"),
    );
    expect(customEvents.map((event) => event.kind)).toEqual([
      "custom_first",
      "custom_second",
    ]);
  });

  it("preserves canonical conversation message kinds", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });
    const task = await client.createTask(baseTaskInput());

    await client.appendComment(task.id, {
      kind: "comment",
      author: human,
      body: "AI QUESTION: this is normal human text, not parsed protocol.",
    });
    await client.appendComment(task.id, {
      kind: "question",
      author: worker,
      payload: { question: "Which API variant should be used?" },
    });

    const comments = (await client.getTask(task.id)).comments;
    expect(comments.map((comment) => comment.kind)).toEqual(["comment", "question"]);
    expect(comments[0]?.body).toContain("AI QUESTION");
  });

  it("enforces external ref uniqueness by provider and external key", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });

    await client.createTask(
      baseTaskInput({
        id: "task-one",
        createdBy: external,
        externalRefs: [{ provider: "neutral-tracker", externalKey: "DEV-1" }],
      }),
    );

    await expect(
      client.createTask(
        baseTaskInput({
          id: "task-two",
          createdBy: external,
          externalRefs: [{ provider: "neutral-tracker", externalKey: "DEV-1" }],
        }),
      ),
    ).rejects.toThrow(/already attached/);
  });

  it("exposes a provider-neutral external source boundary", async () => {
    const source: ExternalTaskSource = {
      async importCandidates() {
        return [
          {
            provider: "neutral-tracker",
            externalKey: "TASK-1",
            title: "External task",
            description: "Provider-neutral snapshot.",
            payload: { providerSpecific: true },
            observedAt: "2026-04-28T10:00:00.000Z",
          },
        ];
      },
      async exportDigest() {},
      async transitionExternal() {},
    };

    await expect(source.importCandidates({ queue: "DEV" })).resolves.toEqual([
      expect.objectContaining({
        provider: "neutral-tracker",
        externalKey: "TASK-1",
      }),
    ]);
  });

  it("builds an agent task context from the canonical task model", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });
    const task = await client.createTask(baseTaskInput());
    await client.markReady(task.id);

    const context = await client.getAgentTaskContext(task.id);

    expect(context).toMatchObject({
      taskId: task.id,
      status: "ready",
      logicalStatus: "open",
      title: "Implement internal tracker",
      activePlan: { schemaVersion: 1, status: "active" },
      latestRevision: { revisionNumber: 1 },
    });
  });

  it("creates an implicit plan for every new task", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });

    const task = await client.createTask(baseTaskInput());

    expect(task.plans).toHaveLength(1);
    expect(task.plans[0]).toMatchObject({
      taskId: task.id,
      status: "active",
      schemaVersion: 1,
      steps: [],
    });
  });

  it("maps internal task statuses to current logical statuses", () => {
    expect(TASK_STATUS_TO_LOGICAL_STATUS).toMatchObject({
      new: "open",
      triage: "open",
      awaiting_human: "waiting_for_answer",
      implementing: "in_progress",
      review: "review",
      done: "done",
      failed: "failed",
      cancelled: "failed",
    });
    expect(mapTaskStatusToLogicalStatus("blocked")).toBe("waiting_for_answer");
  });

  it("preserves schema-versioned decision payloads", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });
    const task = await client.createTask(baseTaskInput());

    await client.recordDecision(task.id, {
      kind: "analysis",
      schemaVersion: 2,
      source: "worker_agent",
      workerId: "worker-1",
      payload: {
        confidence: 83,
        recommendation: "implement",
      },
    });

    const stored = await client.getTask(task.id);
    expect(stored.decisions).toEqual([
      expect.objectContaining({
        kind: "analysis",
        schemaVersion: 2,
        payload: {
          confidence: 83,
          recommendation: "implement",
        },
      }),
    ]);
  });

  it("documents and enforces field ownership groups at the domain boundary", async () => {
    expect(FIELD_OWNERSHIP_RULES.map((rule) => rule.group)).toEqual([
      "human_input",
      "external_snapshot",
      "worker_runtime",
      "gitlab_sync",
      "policy_admin",
    ]);
    expect(canOwnerUpdateFieldGroup("external_source", "human_input")).toBe(true);
    expect(canOwnerUpdateFieldGroup("worker_agent", "human_input")).toBe(false);

    const client = new InMemoryTaskTrackerClient({ now: createClock() });
    const task = await client.createTask(baseTaskInput());

    await expect(
      client.updateTaskRevision(task.id, {
        owner: "worker_agent",
        author: worker,
        title: "Worker must not own this",
      }),
    ).rejects.toThrow(FieldOwnershipError);
  });

  it("records Phase 7D worker runtime structures without service comments", async () => {
    const client = new InMemoryTaskTrackerClient({ now: createClock() });
    const service = new AgentWorkflowService(client);
    const task = await client.createTask(baseTaskInput({ id: "phase-7d" }));

    await service.recordAnalysisDecision(task.id, {
      confidence: 90,
      taskType: "backend_endpoint",
      recommendedMode: "implement",
      promptProfileId: "general",
      expectedFiles: ["src/app.ts"],
      expectedSubsystems: ["worker"],
      riskFactors: [],
      missingContext: [],
      reasoning: "Clear implementation task.",
    });
    await service.recordTaskStep(task.id, { kind: "analyze", status: "done" });
    await service.askClarification(task.id, {
      workerId: "worker-1",
      summary: "Need target API.",
      blockingReason: "API variant is ambiguous.",
      question: "Which API variant should be used?",
      options: ["A"],
      resumeHint: "Reply with /resume A.",
    });
    await service.recordHumanAnswer(task.id, {
      questionId: (await client.getTask(task.id)).clarificationQuestions[0]?.id,
      author: human,
      body: "/resume A",
      command: { type: "resume", rawText: "/resume A", choice: "A" },
    });
    await service.recordAgentRun(task.id, {
      workerId: "worker-1",
      stage: "implementation",
      status: "completed",
      threadId: "thread-1",
      exitCode: 0,
    });
    await service.recordValidation(task.id, {
      workerId: "worker-1",
      status: "passed",
      validation: {
        changed: true,
        testsPassed: true,
        lintPassed: true,
        gates: [],
        diagnostic: "",
      },
    });
    await service.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/ai-task-phase-7d",
      outcome: "created",
      mergeRequest: {
        id: 1,
        iid: 1,
        url: "https://gitlab.example/mr/1",
        title: "MR",
        sourceBranch: "feature/ai-task-phase-7d",
        targetBranch: "main",
      },
    });
    await service.recordMemoryContext(task.id, {
      workerId: "worker-1",
      promptProfileId: "general",
      taskType: "backend_endpoint",
      knowledgeSectionIds: ["architecture"],
      promptRuleIds: ["rule-1"],
      similarFailureCount: 1,
    });

    const stored = await client.getTask(task.id);
    expect(stored.decisions).toHaveLength(1);
    expect(stored.plans[0]?.steps).toEqual([
      expect.objectContaining({ kind: "analyze", status: "done" }),
    ]);
    expect(stored.clarificationQuestions).toHaveLength(1);
    expect(stored.humanAnswers).toHaveLength(1);
    expect(stored.agentRuns).toEqual([
      expect.objectContaining({ stage: "implementation", threadId: "thread-1" }),
    ]);
    expect(stored.qualityGateRuns).toEqual([
      expect.objectContaining({ status: "passed", changed: true }),
    ]);
    expect(stored.mergeRequests).toEqual([
      expect.objectContaining({ branch: "feature/ai-task-phase-7d" }),
    ]);
    expect(stored.memoryContextRefs).toEqual([
      expect.objectContaining({ knowledgeSectionIds: ["architecture"] }),
    ]);
    expect(stored.comments.some((comment) => comment.body?.startsWith("AI "))).toBe(false);
  });
});
