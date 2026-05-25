import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  InMemoryProjectManagerStore,
  type ProjectManagerOrchestrator,
} from "../src/domain/projectManager/index.js";
import { InMemoryTaskTrackerClient } from "../src/domain/taskTracker/index.js";
import type { CreateTaskInput, TaskActor } from "../src/domain/taskTracker/index.js";
import { defaultObservabilityConfig } from "../src/observability/config.js";
import { InMemoryMetricsRegistry } from "../src/observability/metrics.js";
import { ObservabilityHttpServer } from "../src/observability/server.js";
import { InMemoryWorkerStateRegistry } from "../src/observability/state.js";
import type { ProjectManagerApiDependencies } from "../src/observability/taskTrackerHumanApi.js";
import type { TaskTrackerUiConfig } from "../src/models/types.js";

const servers: ObservabilityHttpServer[] = [];

const human: TaskActor = {
  owner: "human",
  id: "dev-1",
  displayName: "Developer One",
};

const baseTaskInput = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  title: "Implement UI",
  description: "Build the human workflow UI.",
  createdBy: human,
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: ["ai_dev"],
  priority: "normal",
  acceptanceCriteria: ["Task can be created."],
  status: "ready",
  ...overrides,
});

const developerHeaders = {
  "content-type": "application/json",
  "x-task-tracker-user": "dev-1",
  "x-task-tracker-role": "developer",
};

const operatorHeaders = {
  "content-type": "application/json",
  "x-task-tracker-user": "ops-1",
  "x-task-tracker-role": "operator",
};

const viewerHeaders = {
  "content-type": "application/json",
  "x-task-tracker-user": "viewer-1",
  "x-task-tracker-role": "viewer",
};

const createServer = async (
  tracker: InMemoryTaskTrackerClient | undefined | null = new InMemoryTaskTrackerClient(),
  taskTrackerUiOverrides: Partial<TaskTrackerUiConfig> = {},
  projectManager?: ProjectManagerApiDependencies,
) => {
  const config = {
    ...defaultObservabilityConfig(),
    enabled: false,
    host: "127.0.0.1",
    port: 0,
    baseUrl: "http://127.0.0.1",
    taskTrackerUi: {
      ...defaultObservabilityConfig().taskTrackerUi,
      enabled: true,
      systemToken: "system-token",
      ...taskTrackerUiOverrides,
    },
  };
  const metrics = new InMemoryMetricsRegistry();
  const state = new InMemoryWorkerStateRegistry();
  state.update({
    workerId: "worker-1",
    state: "idle",
    repositoryName: "developer",
  });
  const server = new ObservabilityHttpServer({
    config,
    metrics,
    state,
    readiness: () => ({ ready: true, reason: "ready" }),
    repositories: () => ["developer"],
    ...(tracker ? { taskTracker: tracker } : {}),
    ...(projectManager ? { projectManager } : {}),
  });
  servers.push(server);
  await server.start();
  const address = server.address() as AddressInfo;
  return {
    tracker,
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const requestJson = async (
  baseUrl: string,
  path: string,
  options: RequestInit = {},
) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
    contentType: response.headers.get("content-type"),
  };
};

const createProjectGoal = async (
  store: InMemoryProjectManagerStore,
  overrides: { sourceAnalysisId?: string; repositoryName?: string; title?: string } = {},
) => {
  const [goal] = await store.createGoalsFromAnalysis({
    sourceAnalysisId: overrides.sourceAnalysisId ?? "analysis-1",
    repositoryName: overrides.repositoryName ?? "developer",
    goals: [
      {
        title: overrides.title ?? "Improve task visibility",
        problemStatement: "Operators cannot see enough project-level context.",
        desiredOutcome: "Project-level goals are visible and reviewable.",
        successMetrics: ["Goals can be reviewed from the human API."],
        evidenceRefs: [
          {
            kind: "metric",
            ref: "pm:test",
            summary: "Project manager analysis found a visibility gap.",
          },
        ],
        priority: "normal",
        riskLevel: "low",
        suggestedTaskProposals: [],
      },
    ],
  });
  return goal!;
};

describe("Phase 7F human task API", () => {
  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
  });

  it("serves read endpoints without falling back to the removed embedded task UI", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "task-read" }));
    await tracker.recordValidation(task.id, {
      workerId: "worker-1",
      status: "passed",
      summary: "Tests passed.",
      validation: {
        changed: true,
        testsPassed: true,
        lintPassed: true,
        gates: [],
        diagnostic: "ok",
      },
    });
    await tracker.recordMergeRequest(task.id, {
      workerId: "worker-1",
      branch: "feature/task-read",
      outcome: "created",
      mergeRequest: {
        id: 1,
        iid: 1,
        url: "https://gitlab.example/mr/1",
        title: "MR",
        sourceBranch: "feature/task-read",
        targetBranch: "main",
      },
    });
    const { baseUrl } = await createServer(tracker);

    const html = await fetch(`${baseUrl}/tasks`);
    expect(html.status).toBe(503);
    expect(await html.text()).not.toContain("Internal Task Tracker");

    const session = await requestJson(baseUrl, "/api/session", {
      headers: developerHeaders,
    });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({
      user: { id: "dev-1", displayName: "dev-1", service: "human" },
      role: "developer",
      authMode: "trusted_proxy",
      apiPath: "/api",
      uiPath: "/tasks",
      capabilities: {
        canReadTasks: true,
        canCreateTask: true,
        canHold: false,
        canCreateSystemTask: false,
      },
    });

    const systemSession = await requestJson(baseUrl, "/api/session", {
      headers: { authorization: "Bearer system-token" },
    });
    expect(systemSession.body).toMatchObject({
      user: { id: "system", service: "system" },
      role: "admin",
      capabilities: { canCreateSystemTask: true },
    });

    const listed = await requestJson(baseUrl, "/api/tasks?status=ready");
    expect(listed.status).toBe(200);
    expect(listed.body.tasks[0]).toMatchObject({
      id: "task-read",
      latestValidationSummary: "Tests passed.",
      mergeRequestUrl: "https://gitlab.example/mr/1",
    });

    const detail = await requestJson(baseUrl, "/api/tasks/task-read");
    expect(detail.body.summary).toMatchObject({
      id: "task-read",
      branch: "feature/task-read",
    });
    expect((await requestJson(baseUrl, "/api/tasks/task-read/events")).body.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "task_created" })]),
    );
    expect(
      (await requestJson(baseUrl, "/api/tasks/task-read/agent-context-preview")).body
        .agentContext,
    ).toMatchObject({ taskId: "task-read", status: "ready" });
  });

  it("allows viewers to list and get project goals", async () => {
    const projectManagerStore = new InMemoryProjectManagerStore();
    const goal = await createProjectGoal(projectManagerStore);
    await projectManagerStore.linkGoalTask({
      goalId: goal.id,
      taskId: "task-1",
      linkType: "suggested",
    });
    await createProjectGoal(projectManagerStore, {
      sourceAnalysisId: "analysis-2",
      title: "Unrelated goal",
    });
    const { baseUrl } = await createServer(new InMemoryTaskTrackerClient(), {}, {
      store: projectManagerStore,
    });

    const listed = await requestJson(
      baseUrl,
      "/api/project-goals?repositoryName=developer&sourceAnalysisId=analysis-1&status=proposed",
      { headers: viewerHeaders },
    );
    expect(listed.status).toBe(200);
    expect(listed.body.goals).toHaveLength(1);
    expect(listed.body.goals[0]).toMatchObject({
      id: goal.id,
      repositoryName: "developer",
      sourceAnalysisId: "analysis-1",
      status: "proposed",
    });

    const repeatedStatusList = await requestJson(
      baseUrl,
      "/api/project-goals?repositoryName=developer&status=proposed&status=approved",
      { headers: viewerHeaders },
    );
    expect(repeatedStatusList.status).toBe(200);
    expect(repeatedStatusList.body.goals.map((entry: { id: string }) => entry.id)).toEqual(
      expect.arrayContaining([goal.id]),
    );

    const detail = await requestJson(baseUrl, `/api/project-goals/${goal.id}`, {
      headers: viewerHeaders,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.goal).toMatchObject({ id: goal.id });
    expect(detail.body.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "project_goal_created" }),
      ]),
    );
    expect(detail.body.taskLinks).toEqual([
      expect.objectContaining({ taskId: "task-1", linkType: "suggested" }),
    ]);
  });

  it("protects project goal approval and rejection by role", async () => {
    const projectManagerStore = new InMemoryProjectManagerStore();
    const approveGoal = await createProjectGoal(projectManagerStore, {
      title: "Approve this goal",
    });
    const rejectGoal = await createProjectGoal(projectManagerStore, {
      title: "Reject this goal",
    });
    const reasonAliasGoal = await createProjectGoal(projectManagerStore, {
      title: "Reject this goal with reason",
    });
    const missingReasonGoal = await createProjectGoal(projectManagerStore, {
      title: "Reject this goal without reason",
    });
    const { baseUrl } = await createServer(new InMemoryTaskTrackerClient(), {}, {
      store: projectManagerStore,
    });

    const viewerApprove = await requestJson(
      baseUrl,
      `/api/project-goals/${approveGoal.id}/commands/approve`,
      {
        method: "POST",
        headers: viewerHeaders,
      },
    );
    expect(viewerApprove.status).toBe(403);

    const viewerReject = await requestJson(
      baseUrl,
      `/api/project-goals/${rejectGoal.id}/commands/reject`,
      {
        method: "POST",
        headers: viewerHeaders,
        body: JSON.stringify({ rejectionReason: "Out of scope." }),
      },
    );
    expect(viewerReject.status).toBe(403);

    const approved = await requestJson(
      baseUrl,
      `/api/project-goals/${approveGoal.id}/commands/approve`,
      {
        method: "POST",
        headers: developerHeaders,
      },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.goal).toMatchObject({
      id: approveGoal.id,
      status: "approved",
      approvedBy: { owner: "human", id: "dev-1" },
    });

    const rejected = await requestJson(
      baseUrl,
      `/api/project-goals/${rejectGoal.id}/commands/reject`,
      {
        method: "POST",
        headers: developerHeaders,
        body: JSON.stringify({ rejectionReason: "Out of scope." }),
      },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.goal).toMatchObject({
      id: rejectGoal.id,
      status: "rejected",
      rejectionReason: "Out of scope.",
      rejectedBy: { owner: "human", id: "dev-1" },
    });

    const rejectedWithReasonAlias = await requestJson(
      baseUrl,
      `/api/project-goals/${reasonAliasGoal.id}/commands/reject`,
      {
        method: "POST",
        headers: developerHeaders,
        body: JSON.stringify({ reason: "Not aligned." }),
      },
    );
    expect(rejectedWithReasonAlias.status).toBe(200);
    expect(rejectedWithReasonAlias.body.goal).toMatchObject({
      id: reasonAliasGoal.id,
      status: "rejected",
      rejectionReason: "Not aligned.",
    });

    const missingReason = await requestJson(
      baseUrl,
      `/api/project-goals/${missingReasonGoal.id}/commands/reject`,
      {
        method: "POST",
        headers: developerHeaders,
        body: JSON.stringify({}),
      },
    );
    expect(missingReason.status).toBe(400);
    expect(missingReason.body.error).toContain("reason is required");
  });

  it("allows operators to run the project manager without a task tracker", async () => {
    const projectManagerStore = new InMemoryProjectManagerStore();
    const calls: Array<{ repositoryName: string; trigger?: string }> = [];
    const runner: Pick<ProjectManagerOrchestrator, "runAnalysisOnce"> = {
      runAnalysisOnce: async (input) => {
        calls.push(input);
        return {
          run: {
            id: "pm-run-1",
            repositoryName: input.repositoryName,
            trigger: input.trigger ?? "manual",
            status: "completed",
            analysisId: "analysis-1",
            proposedGoalIds: ["goal-1"],
            proposedTaskIds: [],
            startedAt: "2026-05-25T00:00:00.000Z",
            completedAt: "2026-05-25T00:01:00.000Z",
          },
          analysis: {
            id: "analysis-1",
            repositoryName: input.repositoryName,
            summary: "Manual analysis completed.",
            healthSignals: [],
            proposedGoals: [],
            staleGoalIds: [],
            createdAt: "2026-05-25T00:01:00.000Z",
          },
        };
      },
    };
    const { baseUrl } = await createServer(null, {}, {
      store: projectManagerStore,
      runner,
    });

    const response = await requestJson(baseUrl, "/api/project-manager/runs", {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ repositoryName: "developer" }),
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ repositoryName: "developer", trigger: "manual" }]);
    expect(response.body.result.run).toMatchObject({
      id: "pm-run-1",
      trigger: "manual",
      status: "completed",
    });
  });

  it("returns 503 for project manager routes when dependencies are absent", async () => {
    const missingProjectManager = await createServer(null);
    const listResponse = await requestJson(
      missingProjectManager.baseUrl,
      "/api/project-goals",
      { headers: viewerHeaders },
    );
    expect(listResponse.status).toBe(503);
    expect(listResponse.body.error).toContain("Project manager API is not configured");

    const missingRunner = await createServer(null, {}, {
      store: new InMemoryProjectManagerStore(),
    });
    const runResponse = await requestJson(
      missingRunner.baseUrl,
      "/api/project-manager/runs",
      {
        method: "POST",
        headers: operatorHeaders,
        body: JSON.stringify({ repositoryName: "developer" }),
      },
    );
    expect(runResponse.status).toBe(503);
    expect(runResponse.body.error).toContain("Project manager runner is not configured");
  });

  it("creates a human task, previews agent context, and marks it ready", async () => {
    const { baseUrl } = await createServer();

    const created = await requestJson(baseUrl, "/api/tasks", {
      method: "POST",
      headers: developerHeaders,
      body: JSON.stringify({
        title: "Draft task",
        description: "Draft description.",
        repositoryName: "developer",
        repoPathKey: "developer",
        baseBranch: "main",
        queue: "DEV",
        acceptanceCriteria: ["Ready can be marked."],
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.task.status).toBe("new");

    const preview = await requestJson(
      baseUrl,
      `/api/tasks/${created.body.task.id}/agent-context-preview`,
    );
    expect(preview.body.agentContext).toMatchObject({
      title: "Draft task",
      status: "new",
    });

    const ready = await requestJson(
      baseUrl,
      `/api/tasks/${created.body.task.id}/commands/mark-ready`,
      {
        method: "POST",
        headers: developerHeaders,
        body: JSON.stringify({ reason: "Approved for execution." }),
      },
    );
    expect(ready.body.task.status).toBe("ready");
  });

  it("reports bearer and localhost session behavior without browser token storage", async () => {
    const bearerServer = await createServer(new InMemoryTaskTrackerClient(), {
      authMode: "bearer",
      agentToken: "agent-token",
    });

    const anonymousBearer = await requestJson(bearerServer.baseUrl, "/api/session");
    expect(anonymousBearer.status).toBe(401);

    const agentSession = await requestJson(bearerServer.baseUrl, "/api/session", {
      headers: { authorization: "Bearer agent-token" },
    });
    expect(agentSession.body).toMatchObject({
      user: { id: "agent-api", service: "agent" },
      role: "operator",
      authMode: "bearer",
      capabilities: {
        canReadTasks: true,
        canCreateTask: true,
        canHold: true,
        canCreateSystemTask: false,
      },
    });

    const localhostServer = await createServer(new InMemoryTaskTrackerClient(), {
      authMode: "localhost",
    });
    const localhostSession = await requestJson(localhostServer.baseUrl, "/api/session");
    expect(localhostSession.body).toMatchObject({
      user: { id: "localhost", displayName: "Localhost", service: "localhost" },
      role: "admin",
      authMode: "localhost",
      capabilities: {
        canReadTasks: true,
        canCreateTask: true,
        canHold: true,
        canCreateSystemTask: false,
      },
    });
  });

  it("creates system tasks idempotently with audit metadata", async () => {
    const { baseUrl } = await createServer();
    const body = {
      source: "scheduler",
      idempotencyKey: "nightly-1",
      createdBy: { owner: "external_source", id: "scheduler" },
      title: "Nightly system task",
      description: "Created by a scheduler.",
      repositoryName: "developer",
      repoPathKey: "developer",
      baseBranch: "main",
      queue: "DEV",
      acceptanceCriteria: ["Audit trail exists."],
      rawSourceMetadata: { schedule: "nightly" },
    };

    const first = await requestJson(baseUrl, "/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer system-token",
      },
      body: JSON.stringify(body),
    });
    const repeated = await requestJson(baseUrl, "/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer system-token",
      },
      body: JSON.stringify(body),
    });

    expect(first.status).toBe(201);
    expect(repeated.status).toBe(200);
    expect(repeated.body.task.id).toBe(first.body.task.id);
    expect(repeated.body.idempotent).toBe(true);
    expect(first.body.task).toMatchObject({
      source: { kind: "system", provider: "scheduler", externalKey: "nightly-1" },
      createdBy: { owner: "external_source", id: "scheduler" },
    });
  });

  it("creates and reviews AI proposals through the human API", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const { baseUrl } = await createServer(tracker);

    const proposed = await requestJson(baseUrl, "/api/proposals", {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({
        proposedBy: "agent-1",
        repositoryName: "developer",
        title: "Document flaky test handling",
        description: "Add a short runbook for flaky test handling.",
        proposalReason: "Repeated validation failures mention the same flaky test.",
        evidenceRefs: [
          {
            kind: "validation_failure",
            ref: "quality-gate:test:flaky-check",
            summary: "Same test failed twice.",
          },
        ],
        suggestedAcceptanceCriteria: ["Runbook explains the flaky test flow."],
        taskType: "documentation",
      }),
    });

    expect(proposed.status).toBe(201);
    expect(proposed.body.proposal).toMatchObject({
      supervisorStatus: "proposed",
      policyEvaluation: { decision: "requires_approval" },
    });

    const proposals = await requestJson(baseUrl, "/api/proposals");
    expect(proposals.body.proposals[0]).toMatchObject({
      id: proposed.body.task.id,
      proposal: {
        supervisorStatus: "proposed",
        suggestedAcceptanceCriteria: ["Runbook explains the flaky test flow."],
      },
    });

    const approved = await requestJson(
      baseUrl,
      `/api/tasks/${proposed.body.task.id}/commands/approve-proposal`,
      {
        method: "POST",
        headers: developerHeaders,
        body: JSON.stringify({ reason: "Safe documentation task." }),
      },
    );
    expect(approved.body.task.status).toBe("ready");
    expect(approved.body.task.proposal.supervisorStatus).toBe("approved");
    expect((await tracker.getTask(proposed.body.task.id)).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "proposal_policy_decision" }),
        expect.objectContaining({ kind: "task_proposal_approved" }),
      ]),
    );
  });

  it("answers clarification, resumes, holds, retries, cancels, and approves decomposition", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const questionTask = await tracker.createTask(baseTaskInput({ id: "question-task" }));
    await tracker.claimNextTask({
      workerId: "worker-1",
      repositoryProfiles: [{ name: "developer", repoPathKey: "developer", queues: ["DEV"] }],
      leaseTtlSeconds: 60,
    });
    await tracker.setStatus(questionTask.id, "awaiting_human");
    await tracker.askClarification(questionTask.id, {
      workerId: "worker-1",
      summary: "Need API choice.",
      blockingReason: "Variant is unclear.",
      question: "Use v1 or v2?",
      options: ["v1", "v2"],
      resumeHint: "Reply with /resume.",
    });
    const holdTask = await tracker.createTask(baseTaskInput({ id: "hold-task" }));
    const failedTask = await tracker.createTask(baseTaskInput({ id: "failed-task" }));
    await tracker.setStatus(failedTask.id, "claimed");
    await tracker.setStatus(failedTask.id, "failed");
    const cancelTask = await tracker.createTask(baseTaskInput({ id: "cancel-task" }));
    const parent = await tracker.createTask(baseTaskInput({ id: "parent-task" }));
    const child = await tracker.createTask(baseTaskInput({ id: "child-task" }));
    await tracker.linkDependency({
      fromTaskId: parent.id,
      toTaskId: child.id,
      kind: "parent_child",
      reason: "Split into a child task.",
    });
    const { baseUrl } = await createServer(tracker);

    const questionId = (await tracker.getTask(questionTask.id)).clarificationQuestions[0]?.id;
    const answered = await requestJson(baseUrl, "/api/tasks/question-task/answers", {
      method: "POST",
      headers: developerHeaders,
      body: JSON.stringify({
        questionId,
        body: "Use v2.",
        command: { type: "resume", rawText: "/resume v2", choice: "v2" },
      }),
    });
    expect(answered.body.task.status).toBe("ready");
    expect(answered.body.task.humanAnswers[0]).toMatchObject({ body: "Use v2." });

    const resumed = await requestJson(baseUrl, "/api/tasks/question-task/commands/resume", {
      method: "POST",
      headers: developerHeaders,
      body: JSON.stringify({ reason: "Answer supplied." }),
    });
    expect(resumed.status).toBe(200);

    const held = await requestJson(baseUrl, `/api/tasks/${holdTask.id}/commands/hold`, {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ reason: "Manual hold." }),
    });
    expect(held.body.task.status).toBe("blocked");

    const retried = await requestJson(baseUrl, `/api/tasks/${failedTask.id}/commands/retry`, {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ reason: "Retry after fix." }),
    });
    expect(retried.body.task.status).toBe("ready");

    const cancelled = await requestJson(baseUrl, `/api/tasks/${cancelTask.id}/commands/cancel`, {
      method: "POST",
      headers: developerHeaders,
      body: JSON.stringify({ reason: "No longer needed." }),
    });
    expect(cancelled.body.task.status).toBe("cancelled");

    await requestJson(baseUrl, "/api/tasks/parent-task/commands/approve-decomposition", {
      method: "POST",
      headers: developerHeaders,
      body: JSON.stringify({ approve: true }),
    });
    const approved = await tracker.getTask(parent.id);
    expect(approved.decisions.at(-1)).toMatchObject({
      kind: "manual",
      payload: { yandexBridge: { approveChildMirroring: true } },
    });
    const detail = await requestJson(baseUrl, "/api/tasks/parent-task");
    expect(detail.body.children[0]).toMatchObject({
      id: "child-task",
      dependencyReason: "Split into a child task.",
    });
  });

  it("protects mutations by role and rejects anonymous writes", async () => {
    const { baseUrl } = await createServer();
    const createBody = {
      title: "Blocked write",
      description: "Should not be created.",
    };

    const viewer = await requestJson(baseUrl, "/api/tasks", {
      method: "POST",
      headers: viewerHeaders,
      body: JSON.stringify(createBody),
    });
    expect(viewer.status).toBe(403);

    const anonymous = await requestJson(baseUrl, "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(anonymous.status).toBe(401);
  });

  it("returns an operations snapshot with safe allowlisted diagnostics", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const failed = await tracker.createTask(baseTaskInput({ id: "failed-ops" }));
    const claimed = await tracker.claimNextTask({
      workerId: "worker-1",
      repositoryProfiles: [{ name: "developer", repoPathKey: "developer", queues: ["DEV"] }],
      leaseTtlSeconds: 60,
    });
    expect(claimed?.task.id).toBe("failed-ops");
    await tracker.recordAgentRun(failed.id, {
      workerId: "worker-1",
      stage: "implementation",
      status: "failed",
      exitCode: 1,
      diagnostic: `TOKEN=super-secret ${"x".repeat(1500)}`,
    });
    await tracker.recordAgentRun(failed.id, {
      workerId: "worker-1",
      stage: "validation",
      status: "failed",
      diagnostic: "Second failure.",
    });
    await tracker.recordValidation(failed.id, {
      workerId: "worker-1",
      status: "failed",
      summary: "Unit tests failed.",
      validation: {
        changed: true,
        testsPassed: false,
        lintPassed: true,
        gates: [],
        diagnostic: "Authorization: Bearer super-secret-token",
      },
    });
    await tracker.recordValidation(failed.id, {
      workerId: "worker-1",
      status: "failed",
      summary: "Unit tests failed again.",
      validation: {
        changed: true,
        testsPassed: false,
        lintPassed: true,
        gates: [],
        diagnostic: "Repeated validation failure.",
      },
    });
    await tracker.setStatus(failed.id, "failed", "Validation failed.");
    const waiting = await tracker.createTask(baseTaskInput({ id: "waiting-ops" }));
    await tracker.setStatus(waiting.id, "claimed");
    await tracker.setStatus(waiting.id, "awaiting_human");
    await tracker.askClarification(waiting.id, {
      workerId: "worker-1",
      summary: "Need API choice.",
      blockingReason: "Variant is unclear.",
      question: "Use v1 or v2?",
      options: ["v1", "v2"],
      resumeHint: "Reply with /resume.",
    });
    const { baseUrl, state } = await createServer(tracker);
    state.update({
      workerId: "worker-1",
      state: "processing",
      repositoryName: "developer",
      issueKey: failed.id,
      stage: "validation",
      error: "Last run failed.",
    });

    const operations = await requestJson(baseUrl, "/api/operations", {
      headers: viewerHeaders,
    });

    expect(operations.status).toBe(200);
    expect(operations.body.workers[0]).toMatchObject({
      workerId: "worker-1",
      currentTaskId: "failed-ops",
      currentIssueKey: "failed-ops",
      currentStage: "validation",
      lastErrorSummary: "Last run failed.",
    });
    expect(operations.body.queueDepth).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repositoryName: "developer",
          queue: "DEV",
          status: "failed",
          priority: "normal",
          depth: 1,
        }),
      ]),
    );
    expect(operations.body.failedTasks[0]).toMatchObject({
      id: "failed-ops",
      activeWorker: "worker-1",
    });
    expect(operations.body.repeatedFailures[0]).toMatchObject({ id: "failed-ops" });
    expect(operations.body.waitingForHuman[0]).toMatchObject({
      id: "waiting-ops",
      blockerReason: "Variant is unclear.",
    });
    const diagnostic = operations.body.taskDiagnostics.find(
      (entry: { taskId: string }) => entry.taskId === "failed-ops",
    );
    expect(diagnostic).toMatchObject({
      taskId: "failed-ops",
      failedAgentRuns: 2,
      repeatedValidationFailures: 2,
      latestFailedAgentRun: {
        workerId: "worker-1",
        status: "failed",
      },
      latestValidation: {
        status: "failed",
      },
    });
    expect(["Unit tests failed.", "Unit tests failed again."]).toContain(
      diagnostic.latestValidation.summary,
    );
    expect(diagnostic.latestFailedAgentRun.diagnostic).not.toContain("super-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("Bearer super-secret-token");
    expect(JSON.stringify(diagnostic)).not.toContain("threadId");
    expect(JSON.stringify(diagnostic)).not.toContain("payload");
    expect(diagnostic.latestFailedAgentRun.diagnostic.length).toBeLessThan(1300);
  });
});
