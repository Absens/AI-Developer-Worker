import type { IncomingMessage, ServerResponse } from "node:http";

import {
  buildProjectGoalTaskProposalInputs,
  PROJECT_MANAGER_PROPOSED_TASK_LINK_TYPE,
  PROJECT_ANALYSIS_KINDS,
  PROJECT_GOAL_STATUSES,
  type ListProjectGoalsInput,
  type ProjectAnalysis,
  type ProjectAnalysisKind,
  type ProjectGoal,
  type ProjectGoalTaskLink,
  type ProjectGoalStatus,
  type ProjectManagerConfig,
  type ProjectManagerOrchestrator,
  type ProjectManagerStore,
} from "../domain/projectManager/index.js";
import type {
  AgentRun,
  CreateTaskInput,
  EvidenceRef,
  ListTasksInput,
  QualityGateRun,
  ProposeTaskInput,
  TaskActor,
  TaskEvent,
  TaskLeaseRecord,
  TaskRecord,
  TaskStatus,
  TaskTrackerClient,
} from "../domain/taskTracker/types.js";
import {
  DuplicateTaskProposalError,
  DuplicateExternalRefError,
  InvalidTaskStatusTransitionError,
  ProposalPolicyError,
  TaskProposalStateError,
  TaskNotFoundError,
  TaskReadinessError,
} from "../domain/taskTracker/index.js";
import type {
  TaskTrackerHumanRole,
  TaskTrackerUiConfig,
} from "../models/types.js";
import { redactSecrets } from "./redaction.js";
import type { WorkerStateRegistry } from "./state.js";

interface TaskTrackerHumanApiInput {
  config: TaskTrackerUiConfig;
  taskTracker?: TaskTrackerClient;
  projectManager?: ProjectManagerApiDependencies;
  state: WorkerStateRegistry;
  repositories: () => string[];
}

export interface ProjectManagerApiDependencies {
  store: ProjectManagerStore;
  runner?: Pick<
    ProjectManagerOrchestrator,
    "runAnalysisOnce" | "runReplanOnce" | "runStrategyOnce"
  >;
  configForRepository?: (repositoryName: string) => ProjectManagerConfig | undefined;
  executionProfileForRepository?: (
    repositoryName: string,
  ) =>
    | {
        repoPathKey?: string;
        baseBranch?: string;
        queue?: string;
        tags?: string[];
      }
    | undefined;
}

interface AuthContext {
  actor: TaskActor;
  role: TaskTrackerHumanRole;
  service: "human" | "system" | "agent" | "localhost" | "anonymous";
}

type CommandName =
  | "mark-ready"
  | "resume"
  | "hold"
  | "cancel"
  | "retry"
  | "force-reanalysis"
  | "approve-decomposition"
  | "approve-proposal"
  | "reject-proposal";

const ROLE_RANK: Record<TaskTrackerHumanRole, number> = {
  viewer: 0,
  developer: 1,
  operator: 2,
  admin: 3,
};

const COMMAND_ROLE: Record<CommandName, TaskTrackerHumanRole> = {
  "mark-ready": "developer",
  resume: "developer",
  hold: "operator",
  cancel: "developer",
  retry: "operator",
  "force-reanalysis": "operator",
  "approve-decomposition": "developer",
  "approve-proposal": "developer",
  "reject-proposal": "developer",
};

const TASK_TEMPLATE_IDS = [
  "frontend_ui_fix",
  "backend_endpoint",
  "tests_only",
  "refactor",
  "dependency_update",
  "documentation",
] as const;

const EVIDENCE_KINDS = [
  "validation_failure",
  "review_comment",
  "ci_run",
  "security_finding",
  "memory_entry",
  "file",
  "metric",
  "external_url",
] as const;

const MAX_OPERATIONS_DIAGNOSTIC_CHARS = 1200;

class HttpApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (response: ServerResponse, statusCode: number, body: unknown): void => {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(redactSecrets(body)));
};

const text = (
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void => {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
};

const headerValue = (
  request: IncomingMessage,
  name: string,
): string | undefined => {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

const parseBearerToken = (request: IncomingMessage): string | undefined => {
  const authorization = headerValue(request, "authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
};

const isLoopbackRequest = (request: IncomingMessage): boolean => {
  const address = request.socket.remoteAddress;
  return (
    !address ||
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
};

const parseRole = (value: string | undefined): TaskTrackerHumanRole => {
  const role = value?.trim().toLowerCase();
  if (
    role === "viewer" ||
    role === "developer" ||
    role === "operator" ||
    role === "admin"
  ) {
    return role;
  }
  return "viewer";
};

const requireObject = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpApiError(400, `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const optionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
};

const requiredString = (value: unknown, label: string): string => {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new HttpApiError(400, `${label} is required.`);
  }
  return parsed;
};

const optionalStringArray = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HttpApiError(400, "Expected an array of strings.");
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
};

const parseTaskStatus = (value: unknown): TaskStatus | undefined => {
  const status = optionalString(value);
  if (!status) {
    return undefined;
  }
  return status as TaskStatus;
};

const parseActor = (value: unknown, fallback: TaskActor): TaskActor => {
  if (value === undefined || value === null) {
    return fallback;
  }
  const raw = requireObject(value, "createdBy");
  const owner = optionalString(raw.owner) as TaskActor["owner"] | undefined;
  const id = requiredString(raw.id, "createdBy.id");
  return {
    owner: owner ?? fallback.owner,
    id,
    ...(optionalString(raw.displayName)
      ? { displayName: optionalString(raw.displayName) }
      : {}),
  };
};

const latestByCreatedAt = <T extends { createdAt: string }>(values: readonly T[]): T | undefined =>
  [...values].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

const latestAgentRun = (task: TaskRecord) =>
  [...task.agentRuns].sort((left, right) =>
    (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt),
  )[0];

const latestFailedAgentRun = (task: TaskRecord) =>
  task.agentRuns
    .filter((run) => run.status === "failed")
    .sort((left, right) =>
      (right.completedAt ?? right.startedAt).localeCompare(
        left.completedAt ?? left.startedAt,
      ),
    )[0];

const truncateDiagnostic = (value: string | undefined): string | undefined => {
  const textValue = optionalString(value);
  if (!textValue) {
    return undefined;
  }
  if (textValue.length <= MAX_OPERATIONS_DIAGNOSTIC_CHARS) {
    return textValue;
  }
  return `${textValue.slice(0, MAX_OPERATIONS_DIAGNOSTIC_CHARS)}\n[diagnostic truncated]`;
};

const summarizeTask = (
  task: TaskRecord,
  activeWorker?: string,
): Record<string, unknown> => {
  const latestValidation = latestByCreatedAt(task.qualityGateRuns);
  const latestMr = latestByCreatedAt(task.mergeRequests);
  const latestRun = latestAgentRun(task);
  const latestEvent = latestByCreatedAt(task.events);
  const openQuestion = [...task.clarificationQuestions]
    .reverse()
    .find((question) => question.status === "open");

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    repositoryName: task.repositoryName,
    queue: task.queue,
    priority: task.priority,
    deadline: task.deadline,
    tags: task.tags,
    taskType: task.taskType,
    activeWorker,
    blockerReason: openQuestion?.question.blockingReason,
    latestAiSummary: latestRun?.finalMessage ?? latestRun?.diagnostic,
    latestValidationSummary: latestValidation?.summary ?? latestValidation?.diagnostic,
    mergeRequestUrl: latestMr?.mergeRequest.url,
    branch: latestMr?.branch,
    updatedAt: task.updatedAt,
    lastEvent: latestEvent
      ? {
          kind: latestEvent.kind,
          message: latestEvent.message,
          createdAt: latestEvent.createdAt,
        }
      : undefined,
  };
};

const responseForError = (error: unknown): { statusCode: number; message: string } => {
  if (error instanceof HttpApiError) {
    return { statusCode: error.statusCode, message: error.message };
  }
  if (error instanceof TaskNotFoundError) {
    return { statusCode: 404, message: error.message };
  }
  if (error instanceof TaskReadinessError) {
    return { statusCode: 422, message: error.message };
  }
  if (error instanceof InvalidTaskStatusTransitionError) {
    return { statusCode: 409, message: error.message };
  }
  if (error instanceof DuplicateExternalRefError) {
    return { statusCode: 409, message: error.message };
  }
  if (error instanceof DuplicateTaskProposalError) {
    return { statusCode: 409, message: error.message };
  }
  if (error instanceof ProposalPolicyError) {
    return { statusCode: 403, message: error.message };
  }
  if (error instanceof TaskProposalStateError) {
    return { statusCode: 409, message: error.message };
  }
  if (
    error instanceof Error &&
    error.message.startsWith("Project manager goal not found:")
  ) {
    return { statusCode: 404, message: error.message };
  }
  if (error instanceof Error && /^Cannot .*project goal/.test(error.message)) {
    return { statusCode: 409, message: error.message };
  }
  return {
    statusCode: 500,
    message: error instanceof Error ? error.message : String(error),
  };
};

export class TaskTrackerHumanApi {
  constructor(private readonly input: TaskTrackerHumanApiInput) {}

  isApiRoute(path: string): boolean {
    const { apiPath } = this.input.config;
    if (path === `${apiPath}/tasks/recent`) {
      return false;
    }
    return (
      path === `${apiPath}/session` ||
      path === `${apiPath}/tasks` ||
      path === `${apiPath}/tasks:bulk-create` ||
      path === `${apiPath}/proposals` ||
      path === `${apiPath}/operations` ||
      path === `${apiPath}/project-goals` ||
      path.startsWith(`${apiPath}/project-goals/`) ||
      path === `${apiPath}/project-manager/analyses` ||
      path === `${apiPath}/project-manager/runs` ||
      path.startsWith(`${apiPath}/tasks/`)
    );
  }

  async handle(
    request: IncomingMessage,
    path: string,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const route = path.slice(this.input.config.apiPath.length) || "/";

      if (request.method === "GET" && route === "/session") {
        const auth = this.requireAuth(request, "viewer");
        json(response, 200, this.buildSession(auth));
        return;
      }

      if (await this.handleProjectManagerRoute(request, route, url, response)) {
        return;
      }

      const tracker = this.requireTracker();

      if (request.method === "GET" && route === "/tasks") {
        const auth = this.requireAuth(request, "viewer");
        const filters = this.parseListFilters(url);
        const [tasks, leases] = await Promise.all([
          tracker.listTasks(filters),
          tracker.listActiveLeases(),
        ]);
        const workerByTask = new Map(
          leases.filter((lease) => lease.kind === "task").map((lease) => [
            lease.taskId,
            lease.workerId,
          ]),
        );
        json(response, 200, {
          tasks: tasks.map((task) => summarizeTask(task, workerByTask.get(task.id))),
          role: auth.role,
          generatedAt: new Date().toISOString(),
        });
        return;
      }

      if (request.method === "GET" && route === "/operations") {
        this.requireAuth(request, "viewer");
        const [tasks, leases] = await Promise.all([
          tracker.listTasks({ limit: 500 }),
          tracker.listActiveLeases(),
        ]);
        json(response, 200, this.buildOperationsSnapshot(tasks, leases));
        return;
      }

      if (request.method === "GET" && route === "/proposals") {
        const auth = this.requireAuth(request, "viewer");
        const supervisorStatus = optionalString(url.searchParams.get("supervisorStatus"));
        const tasks = (await tracker.listTasks({ limit: 500 })).filter(
          (task) =>
            task.proposal &&
            (!supervisorStatus ||
              task.proposal.supervisorStatus === supervisorStatus),
        );
        const projectGoalsByTaskId = await this.projectGoalSummariesByTaskId(
          tasks.map((task) => task.id),
        );
        json(response, 200, {
          proposals: tasks.map((task) =>
            this.summarizeProposal(task, projectGoalsByTaskId.get(task.id) ?? []),
          ),
          role: auth.role,
          generatedAt: new Date().toISOString(),
        });
        return;
      }

      if (request.method === "POST" && route === "/proposals") {
        const auth = this.requireAuth(request, "operator");
        const body = requireObject(await this.readJson(request), "request body");
        const task = await tracker.proposeTask(this.proposeTaskInputFromBody(body, auth));
        json(response, 201, { task, proposal: task.proposal });
        return;
      }

      if (request.method === "POST" && route === "/tasks") {
        const body = requireObject(await this.readJson(request), "request body");
        const auth = this.requireCreateAuth(request, body);
        const result = await this.createTaskFromBody(tracker, body, auth);
        json(response, result.idempotent ? 200 : 201, result);
        return;
      }

      if (request.method === "POST" && route === "/tasks:bulk-create") {
        const body = requireObject(await this.readJson(request), "request body");
        const auth = this.requireAuth(request, "admin", { systemOnly: true });
        const rawTasks = body.tasks;
        if (!Array.isArray(rawTasks)) {
          throw new HttpApiError(400, "tasks must be an array.");
        }
        const tasks = [];
        for (const entry of rawTasks) {
          tasks.push(
            await this.createTaskFromBody(
              tracker,
              requireObject(entry, "tasks[]"),
              auth,
            ),
          );
        }
        json(response, 201, { tasks });
        return;
      }

      const taskRoute = this.parseTaskRoute(route);
      if (!taskRoute) {
        text(response, 404, "not found");
        return;
      }

      const { taskId, suffix } = taskRoute;
      if (request.method === "GET" && suffix === "") {
        this.requireAuth(request, "viewer");
        const [task, leases, allTasks] = await Promise.all([
          tracker.getTask(taskId),
          tracker.listActiveLeases(),
          tracker.listTasks({ limit: 500 }),
        ]);
        const projectGoalsByTaskId = await this.projectGoalSummariesByTaskId([taskId]);
        json(response, 200, {
          ...this.buildTaskDetail(task, leases, allTasks),
          ...((projectGoalsByTaskId.get(taskId)?.length ?? 0) > 0
            ? { projectGoals: projectGoalsByTaskId.get(taskId) }
            : {}),
        });
        return;
      }

      if (request.method === "GET" && suffix === "/events") {
        this.requireAuth(request, "viewer");
        json(response, 200, { events: (await tracker.getTask(taskId)).events });
        return;
      }

      if (request.method === "GET" && suffix === "/comments") {
        this.requireAuth(request, "viewer");
        const task = await tracker.getTask(taskId);
        json(response, 200, {
          comments: task.comments,
          questions: task.clarificationQuestions,
          answers: task.humanAnswers,
        });
        return;
      }

      if (request.method === "GET" && suffix === "/agent-context-preview") {
        this.requireAuth(request, "viewer");
        json(response, 200, { agentContext: await tracker.getAgentTaskContext(taskId) });
        return;
      }

      if (request.method === "POST" && suffix === "/revisions") {
        const auth = this.requireAuth(request, "developer");
        const body = requireObject(await this.readJson(request), "request body");
        const task = await tracker.updateTaskRevision(taskId, {
          owner: "human",
          author: auth.actor,
          ...(optionalString(body.title) ? { title: optionalString(body.title) } : {}),
          ...(optionalString(body.description)
            ? { description: optionalString(body.description) }
            : {}),
          ...(optionalString(body.humanSummary)
            ? { humanSummary: optionalString(body.humanSummary) }
            : {}),
          ...(body.acceptanceCriteria !== undefined
            ? { acceptanceCriteria: optionalStringArray(body.acceptanceCriteria) ?? [] }
            : {}),
          ...(body.constraints !== undefined
            ? { constraints: optionalStringArray(body.constraints) ?? [] }
            : {}),
          ...(body.riskFactors !== undefined
            ? { riskFactors: optionalStringArray(body.riskFactors) ?? [] }
            : {}),
          ...(body.missingContext !== undefined
            ? { missingContext: optionalStringArray(body.missingContext) ?? [] }
            : {}),
          ...(body.requiresReanalysis === true ? { requiresReanalysis: true } : {}),
          ...(optionalString(body.reason) ? { reason: optionalString(body.reason) } : {}),
        });
        json(response, 200, { task });
        return;
      }

      if (request.method === "POST" && suffix === "/attachments") {
        const auth = this.requireAuth(request, "developer");
        const body = requireObject(await this.readJson(request), "request body");
        await tracker.appendEvent(taskId, {
          kind: "attachments_registered",
          source: auth.actor.owner,
          actor: auth.actor,
          message: optionalString(body.message) ?? "Attachment metadata registered.",
          payload: {
            attachments: Array.isArray(body.attachments) ? body.attachments : [],
            externalLinks: Array.isArray(body.externalLinks) ? body.externalLinks : [],
          },
        });
        json(response, 200, { task: await tracker.getTask(taskId) });
        return;
      }

      if (request.method === "POST" && suffix === "/answers") {
        const auth = this.requireAuth(request, "developer");
        const body = requireObject(await this.readJson(request), "request body");
        await tracker.recordHumanAnswer(taskId, {
          ...(optionalString(body.questionId)
            ? { questionId: optionalString(body.questionId) }
            : {}),
          author: auth.actor,
          body: requiredString(body.body, "body"),
          ...(body.command && typeof body.command === "object"
            ? {
                command: {
                  type: optionalString((body.command as Record<string, unknown>).type) as
                    | "resume"
                    | "skip"
                    | "cancel",
                  rawText:
                    optionalString((body.command as Record<string, unknown>).rawText) ??
                    requiredString(body.body, "body"),
                  ...(optionalString((body.command as Record<string, unknown>).choice)
                    ? {
                        choice: optionalString(
                          (body.command as Record<string, unknown>).choice,
                        ),
                      }
                    : {}),
                  ...(optionalString((body.command as Record<string, unknown>).freeform)
                    ? {
                        freeform: optionalString(
                          (body.command as Record<string, unknown>).freeform,
                        ),
                      }
                    : {}),
                },
              }
            : {}),
        });
        json(response, 200, { task: await tracker.getTask(taskId) });
        return;
      }

      const command = this.parseCommandSuffix(suffix);
      if (request.method === "POST" && command) {
        const auth = this.requireAuth(request, COMMAND_ROLE[command]);
        const body = await this.readOptionalJson(request);
        await this.applyCommand(tracker, taskId, command, auth, body);
        json(response, 200, { task: await tracker.getTask(taskId) });
        return;
      }

      text(response, 405, "method not allowed");
    } catch (error) {
      const { statusCode, message } = responseForError(error);
      json(response, statusCode, { status: "error", error: message });
    }
  }

  private requireTracker(): TaskTrackerClient {
    if (!this.input.taskTracker) {
      throw new HttpApiError(503, "Internal task tracker is not configured.");
    }
    return this.input.taskTracker;
  }

  private requireProjectManagerStore(): ProjectManagerStore {
    if (!this.input.projectManager) {
      throw new HttpApiError(503, "Project manager API is not configured.");
    }
    return this.input.projectManager.store;
  }

  private requireProjectManagerRunner(): Pick<
    ProjectManagerOrchestrator,
    "runAnalysisOnce" | "runReplanOnce" | "runStrategyOnce"
  > {
    if (!this.input.projectManager) {
      throw new HttpApiError(503, "Project manager API is not configured.");
    }
    if (!this.input.projectManager.runner) {
      throw new HttpApiError(503, "Project manager runner is not configured.");
    }
    return this.input.projectManager.runner;
  }

  private async handleProjectManagerRoute(
    request: IncomingMessage,
    route: string,
    url: URL,
    response: ServerResponse,
  ): Promise<boolean> {
    if (route === "/project-goals") {
      if (request.method !== "GET") {
        text(response, 405, "method not allowed");
        return true;
      }
      const auth = this.requireAuth(request, "viewer");
      const store = this.requireProjectManagerStore();
      const goals = await store.listGoals(this.parseProjectGoalFilters(url));
      const linkedTaskCounts = Object.fromEntries(
        await Promise.all(
          goals.map(async (goal) => [
            goal.id,
            (await store.listGoalTaskLinks(goal.id)).length,
          ]),
        ),
      );
      json(response, 200, {
        goals,
        linkedTaskCounts,
        role: auth.role,
        generatedAt: new Date().toISOString(),
      });
      return true;
    }

    if (route === "/project-manager/analyses") {
      if (request.method !== "GET") {
        text(response, 405, "method not allowed");
        return true;
      }
      this.requireAuth(request, "viewer");
      const filters = this.parseProjectAnalysisFilters(url);
      const analyses = (await this.requireProjectManagerStore().listAnalyses())
        .filter(
          (analysis) =>
            (!filters.repositoryName ||
              analysis.repositoryName === filters.repositoryName) &&
            (!filters.analysisKind || analysis.analysisKind === filters.analysisKind),
        )
        .sort(
          (left, right) =>
            Date.parse(right.createdAt) - Date.parse(left.createdAt),
        );
      json(response, 200, {
        analyses: analyses.map((analysis) => this.summarizeProjectAnalysis(analysis)),
      });
      return true;
    }

    const goalRoute = this.parseProjectGoalRoute(route);
    if (goalRoute) {
      const { goalId, suffix } = goalRoute;
      if (suffix === "") {
        if (request.method !== "GET") {
          text(response, 405, "method not allowed");
          return true;
        }
        this.requireAuth(request, "viewer");
        const store = this.requireProjectManagerStore();
        const [goal, auditEvents, taskLinks] = await Promise.all([
          store.getGoal(goalId),
          store.listGoalEvents(goalId),
          store.listGoalTaskLinks(goalId),
        ]);
        const linkedTasks = await this.linkedTaskSummaries(taskLinks);
        json(response, 200, {
          goal,
          auditEvents,
          taskLinks,
          ...(linkedTasks ? { linkedTasks } : {}),
        });
        return true;
      }

      if (suffix === "/commands/approve") {
        if (request.method !== "POST") {
          text(response, 405, "method not allowed");
          return true;
        }
        const auth = this.requireAuth(request, "developer");
        const goal = await this.requireProjectManagerStore().approveGoal(goalId, {
          actor: auth.actor,
        });
        json(response, 200, { goal });
        return true;
      }

      if (suffix === "/commands/reject") {
        if (request.method !== "POST") {
          text(response, 405, "method not allowed");
          return true;
        }
        const auth = this.requireAuth(request, "developer");
        const body = requireObject(await this.readJson(request), "request body");
        const goal = await this.requireProjectManagerStore().rejectGoal(goalId, {
          actor: auth.actor,
          rejectionReason:
            optionalString(body.rejectionReason) ??
            requiredString(body.reason, "reason"),
        });
        json(response, 200, { goal });
        return true;
      }

      if (suffix === "/commands/complete") {
        if (request.method !== "POST") {
          text(response, 405, "method not allowed");
          return true;
        }
        const auth = this.requireAuth(request, "developer");
        await this.readOptionalJson(request);
        const goal = await this.requireProjectManagerStore().completeGoal(goalId, {
          actor: auth.actor,
        });
        json(response, 200, { goal });
        return true;
      }

      if (suffix === "/commands/stale") {
        if (request.method !== "POST") {
          text(response, 405, "method not allowed");
          return true;
        }
        const auth = this.requireAuth(request, "developer");
        const body = requireObject(await this.readJson(request), "request body");
        const goal = await this.requireProjectManagerStore().markGoalStale(goalId, {
          actor: auth.actor,
          staleReason: requiredString(body.reason, "reason"),
        });
        json(response, 200, { goal });
        return true;
      }

      if (suffix === "/commands/propose-tasks") {
        if (request.method !== "POST") {
          text(response, 405, "method not allowed");
          return true;
        }
        this.requireAuth(request, "operator");
        await this.readOptionalJson(request);
        const store = this.requireProjectManagerStore();
        const tracker = this.requireTracker();
        const goal = await store.getGoal(goalId);
        if (goal.status !== "approved" && goal.status !== "active") {
          throw new Error(
            `Cannot propose tasks for project goal from status ${goal.status}.`,
          );
        }
        const executionProfile =
          this.input.projectManager?.executionProfileForRepository?.(
            goal.repositoryName,
          );
        const tasks = [];
        const taskLinks = [];
        for (const proposalInput of buildProjectGoalTaskProposalInputs({
          goal,
          config: this.input.projectManager?.configForRepository?.(
            goal.repositoryName,
          ),
        })) {
          const task = await tracker.proposeTask({
            ...proposalInput,
            autonomyLevel: "proposal_only",
            ...(executionProfile?.repoPathKey
              ? { repoPathKey: executionProfile.repoPathKey }
              : {}),
            ...(executionProfile?.baseBranch
              ? { baseBranch: executionProfile.baseBranch }
              : {}),
            ...(executionProfile?.queue ? { queue: executionProfile.queue } : {}),
            ...(executionProfile?.tags ? { tags: [...executionProfile.tags] } : {}),
          });
          tasks.push(task);
          taskLinks.push(
            await store.linkGoalTask({
              goalId: goal.id,
              taskId: task.id,
              linkType: PROJECT_MANAGER_PROPOSED_TASK_LINK_TYPE,
            }),
          );
        }
        json(response, 200, {
          goal,
          tasks,
          proposals: tasks.map((task) => task.proposal).filter(Boolean),
          taskLinks,
        });
        return true;
      }

      text(response, 404, "not found");
      return true;
    }

    if (route === "/project-manager/runs") {
      if (request.method !== "POST") {
        text(response, 405, "method not allowed");
        return true;
      }
      this.requireAuth(request, "operator");
      const body = requireObject(await this.readJson(request), "request body");
      const repositoryName = requiredString(body.repositoryName, "repositoryName");
      const mode = body.mode === undefined ? "analysis" : optionalString(body.mode);
      const runner = this.requireProjectManagerRunner();
      let result;
      if (mode === "analysis") {
        result = await runner.runAnalysisOnce({
          repositoryName,
          trigger: "manual",
        });
      } else if (mode === "replan") {
        result = await runner.runReplanOnce({
          repositoryName,
          trigger: "manual",
          replanReason: requiredString(body.replanReason, "replanReason"),
        });
      } else if (mode === "strategy") {
        const strategyBrief = optionalString(body.strategyBrief);
        if (strategyBrief && strategyBrief.length > 2000) {
          throw new HttpApiError(
            400,
            "strategyBrief must be at most 2000 characters.",
          );
        }
        const repositoryProfile =
          this.input.projectManager?.executionProfileForRepository?.(repositoryName);
        result = await runner.runStrategyOnce({
          repositoryName,
          trigger: "manual",
          ...(strategyBrief ? { strategyBrief } : {}),
          ...(repositoryProfile
            ? {
                repositoryProfile: {
                  ...(repositoryProfile.baseBranch
                    ? { baseBranch: repositoryProfile.baseBranch }
                    : {}),
                  ...(repositoryProfile.queue ? { queue: repositoryProfile.queue } : {}),
                  ...(repositoryProfile.tags ? { tags: repositoryProfile.tags } : {}),
                },
              }
            : {}),
        });
      } else {
        throw new HttpApiError(
          400,
          "mode must be one of: analysis, replan, strategy.",
        );
      }
      json(response, 200, { result });
      return true;
    }

    return false;
  }

  private buildSession(auth: AuthContext): Record<string, unknown> {
    const canRole = (role: TaskTrackerHumanRole): boolean =>
      ROLE_RANK[auth.role] >= ROLE_RANK[role];
    const hasProjectManagerStore = Boolean(this.input.projectManager);
    const hasProjectManagerRunner = Boolean(this.input.projectManager?.runner);
    const hasTaskTracker = Boolean(this.input.taskTracker);

    return {
      user: {
        id: auth.actor.id,
        ...(auth.actor.displayName ? { displayName: auth.actor.displayName } : {}),
        service: auth.service,
      },
      role: auth.role,
      authMode: this.input.config.authMode,
      capabilities: {
        canReadTasks: canRole("viewer"),
        canCreateTask: canRole("developer"),
        canUpdateTask: canRole("developer"),
        canAnswer: canRole("developer"),
        canResume: canRole("developer"),
        canCancel: canRole("developer"),
        canHold: canRole("operator"),
        canRetry: canRole("operator"),
        canForceReanalysis: canRole("operator"),
        canApproveProposal: canRole("developer"),
        canRejectProposal: canRole("developer"),
        canApproveDecomposition: canRole("developer"),
        canReadOperations: canRole("viewer"),
        canCreateSystemTask: auth.service === "system" && canRole("admin"),
        canReadProjectGoals: canRole("viewer") && hasProjectManagerStore,
        canApproveProjectGoals: canRole("developer") && hasProjectManagerStore,
        canProposeProjectGoalTasks:
          canRole("operator") && hasProjectManagerStore && hasTaskTracker,
        canCompleteProjectGoals: canRole("developer") && hasProjectManagerStore,
        canMarkProjectGoalsStale: canRole("developer") && hasProjectManagerStore,
        canRunProjectManager: canRole("operator") && hasProjectManagerRunner,
      },
      apiPath: this.input.config.apiPath,
      uiPath: this.input.config.path,
      generatedAt: new Date().toISOString(),
    };
  }

  private requireCreateAuth(
    request: IncomingMessage,
    body: Record<string, unknown>,
  ): AuthContext {
    if (body.idempotencyKey || this.isSystemSource(body.source)) {
      return this.requireAuth(request, "admin", { systemOnly: true });
    }
    return this.requireAuth(request, "developer");
  }

  private requireAuth(
    request: IncomingMessage,
    role: TaskTrackerHumanRole,
    options: { systemOnly?: boolean } = {},
  ): AuthContext {
    const auth = this.authenticate(request);
    if (!auth) {
      throw new HttpApiError(401, "unauthorized");
    }
    if (options.systemOnly && auth.service !== "system") {
      throw new HttpApiError(403, "system token is required.");
    }
    if (auth.service === "anonymous" && role !== "viewer") {
      throw new HttpApiError(401, "unauthorized");
    }
    if (ROLE_RANK[auth.role] < ROLE_RANK[role]) {
      throw new HttpApiError(403, "forbidden");
    }
    return auth;
  }

  private authenticate(request: IncomingMessage): AuthContext | undefined {
    const token = parseBearerToken(request);
    if (token && this.input.config.systemToken && token === this.input.config.systemToken) {
      return {
        actor: { owner: "external_source", id: "system" },
        role: "admin",
        service: "system",
      };
    }
    if (token && this.input.config.agentToken && token === this.input.config.agentToken) {
      return {
        actor: { owner: "worker_agent", id: "agent-api" },
        role: "operator",
        service: "agent",
      };
    }

    if (this.input.config.authMode === "bearer") {
      return undefined;
    }

    const user =
      headerValue(request, this.input.config.trustedUserHeader) ??
      headerValue(request, "x-forwarded-user") ??
      headerValue(request, "x-auth-request-user") ??
      headerValue(request, "x-remote-user");
    if (user?.trim()) {
      const role =
        headerValue(request, this.input.config.trustedRoleHeader) ??
        headerValue(request, "x-forwarded-role") ??
        headerValue(request, "x-auth-request-role");
      return {
        actor: { owner: "human", id: user.trim(), displayName: user.trim() },
        role: parseRole(role),
        service: "human",
      };
    }

    if (this.input.config.authMode === "localhost" && isLoopbackRequest(request)) {
      return {
        actor: { owner: "human", id: "localhost", displayName: "Localhost" },
        role: "admin",
        service: "localhost",
      };
    }

    if (isLoopbackRequest(request)) {
      return {
        actor: { owner: "human", id: "anonymous-local-viewer" },
        role: "viewer",
        service: "anonymous",
      };
    }

    return undefined;
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > 1024 * 1024) {
        throw new HttpApiError(413, "request body is too large.");
      }
      chunks.push(buffer);
    }
    if (chunks.length === 0) {
      throw new HttpApiError(400, "request body is required.");
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      throw new HttpApiError(
        400,
        `request body must be valid JSON. ${(error as Error).message}`,
      );
    }
  }

  private async readOptionalJson(
    request: IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    if (chunks.length === 0) {
      return {};
    }
    try {
      return requireObject(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
        "request body",
      );
    } catch (error) {
      if (error instanceof HttpApiError) {
        throw error;
      }
      throw new HttpApiError(
        400,
        `request body must be valid JSON. ${(error as Error).message}`,
      );
    }
  }

  private parseListFilters(url: URL): ListTasksInput {
    const statuses = url.searchParams.getAll("status") as TaskStatus[];
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    return {
      ...(statuses.length > 0 ? { statuses } : {}),
      ...(url.searchParams.get("repository")
        ? { repositoryName: url.searchParams.get("repository") ?? undefined }
        : {}),
      ...(url.searchParams.get("queue")
        ? { queue: url.searchParams.get("queue") ?? undefined }
        : {}),
      ...(url.searchParams.get("priority")
        ? { priority: url.searchParams.get("priority") ?? undefined }
        : {}),
      ...(url.searchParams.get("worker")
        ? { workerId: url.searchParams.get("worker") ?? undefined }
        : {}),
      ...(url.searchParams.get("tag")
        ? { tag: url.searchParams.get("tag") ?? undefined }
        : {}),
      ...(Number.isInteger(limit) && limit && limit > 0 ? { limit } : {}),
    };
  }

  private parseProjectGoalFilters(url: URL): ListProjectGoalsInput {
    const statuses = url.searchParams.getAll("status").filter(Boolean).map((status) => {
      if (!PROJECT_GOAL_STATUSES.includes(status as ProjectGoalStatus)) {
        throw new HttpApiError(400, `Unsupported project goal status: ${status}`);
      }
      return status as ProjectGoalStatus;
    });
    return {
      ...(url.searchParams.get("repositoryName")
        ? { repositoryName: url.searchParams.get("repositoryName") ?? undefined }
        : {}),
      ...(url.searchParams.get("sourceAnalysisId")
        ? { sourceAnalysisId: url.searchParams.get("sourceAnalysisId") ?? undefined }
        : {}),
      ...(statuses.length === 1
        ? { status: statuses[0] }
        : statuses.length > 1
          ? { status: statuses }
          : {}),
    };
  }

  private parseProjectAnalysisFilters(url: URL): {
    repositoryName?: string;
    analysisKind?: ProjectAnalysisKind;
  } {
    const repositoryName = optionalString(
      url.searchParams.get("repositoryName") ?? undefined,
    );
    const rawKind = optionalString(
      url.searchParams.get("analysisKind") ?? undefined,
    );
    if (rawKind && !PROJECT_ANALYSIS_KINDS.includes(rawKind as ProjectAnalysisKind)) {
      throw new HttpApiError(
        400,
        "analysisKind must be one of: analysis, replan, strategy.",
      );
    }
    return {
      ...(repositoryName ? { repositoryName } : {}),
      ...(rawKind ? { analysisKind: rawKind as ProjectAnalysisKind } : {}),
    };
  }

  private parseTaskRoute(route: string): { taskId: string; suffix: string } | null {
    if (!route.startsWith("/tasks/")) {
      return null;
    }
    const rest = route.slice("/tasks/".length);
    const separator = rest.indexOf("/");
    if (separator === -1) {
      return { taskId: decodeURIComponent(rest), suffix: "" };
    }
    return {
      taskId: decodeURIComponent(rest.slice(0, separator)),
      suffix: rest.slice(separator),
    };
  }

  private parseProjectGoalRoute(route: string): { goalId: string; suffix: string } | null {
    if (!route.startsWith("/project-goals/")) {
      return null;
    }
    const rest = route.slice("/project-goals/".length);
    const separator = rest.indexOf("/");
    if (separator === -1) {
      return { goalId: decodeURIComponent(rest), suffix: "" };
    }
    return {
      goalId: decodeURIComponent(rest.slice(0, separator)),
      suffix: rest.slice(separator),
    };
  }

  private parseCommandSuffix(suffix: string): CommandName | undefined {
    const match = suffix.match(/^\/commands\/([^/]+)$/);
    const command = match?.[1] as CommandName | undefined;
    return command && command in COMMAND_ROLE ? command : undefined;
  }

  private parseEvidenceRefs(value: unknown): EvidenceRef[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new HttpApiError(400, "evidenceRefs must be a non-empty array.");
    }
    return value.map((entry, index) => {
      const raw = requireObject(entry, `evidenceRefs[${index}]`);
      const kind = requiredString(raw.kind, `evidenceRefs[${index}].kind`);
      if (!EVIDENCE_KINDS.includes(kind as any)) {
        throw new HttpApiError(400, `Unsupported evidence kind: ${kind}`);
      }
      return {
        kind: kind as EvidenceRef["kind"],
        ref: requiredString(raw.ref, `evidenceRefs[${index}].ref`),
        ...(optionalString(raw.summary)
          ? { summary: optionalString(raw.summary) }
          : {}),
      };
    });
  }

  private parseAutonomyLevel(value: unknown): ProposeTaskInput["autonomyLevel"] {
    const level = optionalString(value) ?? "proposal_only";
    if (
      level === "proposal_only" ||
      level === "auto_triage" ||
      level === "auto_execute_low_risk"
    ) {
      return level;
    }
    throw new HttpApiError(
      400,
      "autonomyLevel must be one of: proposal_only, auto_triage, auto_execute_low_risk.",
    );
  }

  private proposeTaskInputFromBody(
    body: Record<string, unknown>,
    auth: AuthContext,
  ): ProposeTaskInput {
    return {
      source: "ai_proposal",
      proposedBy: optionalString(body.proposedBy) ?? auth.actor.id,
      repositoryName: requiredString(body.repositoryName, "repositoryName"),
      title: requiredString(body.title, "title"),
      description: requiredString(body.description, "description"),
      proposalReason: requiredString(body.proposalReason, "proposalReason"),
      evidenceRefs: this.parseEvidenceRefs(body.evidenceRefs),
      suggestedAcceptanceCriteria:
        optionalStringArray(body.suggestedAcceptanceCriteria) ??
        optionalStringArray(body.acceptanceCriteria) ??
        [],
      ...(TASK_TEMPLATE_IDS.includes(optionalString(body.taskType) as any)
        ? { taskType: optionalString(body.taskType) as ProposeTaskInput["taskType"] }
        : {}),
      ...(optionalString(body.promptProfileId)
        ? { promptProfileId: optionalString(body.promptProfileId) }
        : {}),
      ...(body.riskFactors !== undefined
        ? { riskFactors: optionalStringArray(body.riskFactors) ?? [] }
        : {}),
      ...(optionalString(body.expectedBlastRadius)
        ? { expectedBlastRadius: optionalString(body.expectedBlastRadius) }
        : {}),
      autonomyLevel: this.parseAutonomyLevel(body.autonomyLevel),
      ...(optionalString(body.approvalPolicy)
        ? { approvalPolicy: optionalString(body.approvalPolicy) }
        : {}),
      ...(optionalString(body.idempotencyKey)
        ? { idempotencyKey: optionalString(body.idempotencyKey) }
        : {}),
      ...(optionalString(body.repoPathKey)
        ? { repoPathKey: optionalString(body.repoPathKey) }
        : {}),
      ...(optionalString(body.baseBranch) ? { baseBranch: optionalString(body.baseBranch) } : {}),
      ...(optionalString(body.queue) ? { queue: optionalString(body.queue) } : {}),
      ...(body.tags !== undefined ? { tags: optionalStringArray(body.tags) ?? [] } : {}),
      ...(body.components !== undefined
        ? { components: optionalStringArray(body.components) ?? [] }
        : {}),
      ...(optionalString(body.priority) ? { priority: optionalString(body.priority) } : {}),
    };
  }

  private async createTaskFromBody(
    tracker: TaskTrackerClient,
    body: Record<string, unknown>,
    auth: AuthContext,
  ): Promise<{ task: TaskRecord; idempotent: boolean }> {
    const serviceSource = optionalString(body.source) ?? "system";
    const idempotencyKey = optionalString(body.idempotencyKey);
    const externalRefs = Array.isArray(body.externalRefs)
      ? body.externalRefs.map((entry) => {
          const raw = requireObject(entry, "externalRefs[]");
          return {
            provider: requiredString(raw.provider, "externalRefs[].provider"),
            externalKey: requiredString(raw.externalKey, "externalRefs[].externalKey"),
            ...(optionalString(raw.externalUrl)
              ? { externalUrl: optionalString(raw.externalUrl) }
              : {}),
            ...(optionalString(raw.businessStatus)
              ? { businessStatus: optionalString(raw.businessStatus) }
              : {}),
          };
        })
      : [];

    if (auth.service === "system") {
      if (!idempotencyKey) {
        throw new HttpApiError(400, "idempotencyKey is required for system tasks.");
      }
      const provider = `system:${serviceSource}`;
      const existing = await tracker.findTaskByExternalRef(provider, idempotencyKey);
      if (existing) {
        return { task: existing, idempotent: true };
      }
      if (
        !externalRefs.some(
          (ref) => ref.provider === provider && ref.externalKey === idempotencyKey,
        )
      ) {
        externalRefs.push({ provider, externalKey: idempotencyKey });
      }
    }

    const fallbackActor: TaskActor =
      auth.service === "system"
        ? { owner: "external_source", id: "system" }
        : auth.actor;
    const createdBy = parseActor(body.createdBy, fallbackActor);
    const input: CreateTaskInput = {
      ...(optionalString(body.id) ? { id: optionalString(body.id) } : {}),
      title: requiredString(body.title, "title"),
      description: requiredString(body.description, "description"),
      ...(optionalString(body.humanSummary)
        ? { humanSummary: optionalString(body.humanSummary) }
        : {}),
      source:
        auth.service === "system"
          ? { kind: "system", provider: serviceSource, externalKey: idempotencyKey }
          : { kind: "native" },
      createdBy,
      ...(optionalString(body.repositoryName)
        ? { repositoryName: optionalString(body.repositoryName) }
        : {}),
      ...(optionalString(body.repoPathKey)
        ? { repoPathKey: optionalString(body.repoPathKey) }
        : {}),
      ...(optionalString(body.baseBranch) ? { baseBranch: optionalString(body.baseBranch) } : {}),
      ...(optionalString(body.queue) ? { queue: optionalString(body.queue) } : {}),
      ...(body.tags !== undefined ? { tags: optionalStringArray(body.tags) ?? [] } : {}),
      ...(body.components !== undefined
        ? { components: optionalStringArray(body.components) ?? [] }
        : {}),
      ...(optionalString(body.priority) ? { priority: optionalString(body.priority) } : {}),
      ...(optionalString(body.deadline) ? { deadline: optionalString(body.deadline) } : {}),
      ...(parseTaskStatus(body.status) ? { status: parseTaskStatus(body.status) } : {}),
      ...(optionalString(body.businessStatus)
        ? { businessStatus: optionalString(body.businessStatus) }
        : {}),
      ...(TASK_TEMPLATE_IDS.includes(optionalString(body.taskType) as any)
        ? { taskType: optionalString(body.taskType) as CreateTaskInput["taskType"] }
        : {}),
      ...(optionalString(body.promptProfileId)
        ? { promptProfileId: optionalString(body.promptProfileId) }
        : {}),
      ...(typeof body.confidence === "number" ? { confidence: body.confidence } : {}),
      ...(body.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: optionalStringArray(body.acceptanceCriteria) ?? [] }
        : {}),
      ...(body.constraints !== undefined
        ? { constraints: optionalStringArray(body.constraints) ?? [] }
        : {}),
      ...(body.riskFactors !== undefined
        ? { riskFactors: optionalStringArray(body.riskFactors) ?? [] }
        : {}),
      ...(body.missingContext !== undefined
        ? { missingContext: optionalStringArray(body.missingContext) ?? [] }
        : {}),
      ...(externalRefs.length > 0 ? { externalRefs } : {}),
      ...(body.rawSourceMetadata || body.externalSnapshot
        ? {
            externalSnapshot: requireObject(
              body.rawSourceMetadata ?? body.externalSnapshot,
              "rawSourceMetadata",
            ),
          }
        : {}),
    };

    return { task: await tracker.createTask(input), idempotent: false };
  }

  private isSystemSource(value: unknown): boolean {
    if (typeof value === "string") {
      return true;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    return (value as { kind?: unknown }).kind === "system";
  }

  private async applyCommand(
    tracker: TaskTrackerClient,
    taskId: string,
    command: CommandName,
    auth: AuthContext,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (command === "mark-ready") {
      await tracker.markReady(taskId, optionalString(body.reason));
      return;
    }
    if (command === "resume") {
      await tracker.setStatus(taskId, "ready", optionalString(body.reason) ?? "Human resumed task.");
      return;
    }
    if (command === "hold") {
      await tracker.setStatus(taskId, "blocked", optionalString(body.reason) ?? "Task put on hold.");
      return;
    }
    if (command === "cancel") {
      await tracker.setStatus(taskId, "cancelled", optionalString(body.reason) ?? "Task cancelled.");
      return;
    }
    if (command === "retry") {
      await tracker.setStatus(taskId, "ready", optionalString(body.reason) ?? "Task queued for retry.");
      return;
    }
    if (command === "force-reanalysis") {
      await tracker.recordDecision(taskId, {
        kind: "manual",
        schemaVersion: 1,
        source: auth.actor.owner,
        authorId: auth.actor.id,
        payload: {
          command: "force_reanalysis",
          reason: optionalString(body.reason) ?? "Human requested reanalysis.",
        },
      });
      await tracker.appendEvent(taskId, {
        kind: "force_reanalysis_requested",
        source: auth.actor.owner,
        actor: auth.actor,
        message: optionalString(body.reason) ?? "Human requested reanalysis.",
      });
      return;
    }
    if (command === "approve-decomposition") {
      await tracker.recordDecision(taskId, {
        kind: "manual",
        schemaVersion: 1,
        source: auth.actor.owner,
        authorId: auth.actor.id,
        payload: {
          yandexBridge: {
            approveChildMirroring: body.approve !== false,
          },
          reason: optionalString(body.reason),
        },
      });
      return;
    }
    if (command === "approve-proposal") {
      await tracker.approveProposal(taskId, {
        actor: auth.actor,
        reason: optionalString(body.reason) ?? "Proposal approved from review API.",
      });
      return;
    }
    if (command === "reject-proposal") {
      await tracker.rejectProposal(taskId, {
        actor: auth.actor,
        reason: optionalString(body.reason) ?? "Proposal rejected from review API.",
      });
      return;
    }
  }

  private summarizeProjectGoal(goal: ProjectGoal): Record<string, unknown> {
    return {
      id: goal.id,
      title: goal.title,
      status: goal.status,
      priority: goal.priority,
      riskLevel: goal.riskLevel,
      repositoryName: goal.repositoryName,
    };
  }

  private summarizeProjectAnalysis(analysis: ProjectAnalysis): Record<string, unknown> {
    return {
      id: analysis.id,
      repositoryName: analysis.repositoryName,
      analysisKind: analysis.analysisKind,
      summary: analysis.summary,
      createdAt: analysis.createdAt,
      ...(analysis.analysisKind === "strategy"
        ? {
            strategy: {
              summary: analysis.summary,
              analysisLenses: analysis.strategyAnalysisLenses,
              opportunities: analysis.strategyOpportunities,
              goalLinks: analysis.strategyGoalLinks,
              questionsForHuman: analysis.strategyQuestions,
            },
          }
        : {}),
    };
  }

  private async projectGoalSummariesByTaskId(
    taskIds: string[],
  ): Promise<Map<string, Record<string, unknown>[]>> {
    if (!this.input.projectManager || taskIds.length === 0) {
      return new Map();
    }
    const links =
      await this.input.projectManager.store.listGoalTaskLinksForTaskIds(taskIds);
    const goalsById = new Map(
      await Promise.all(
        [...new Set(links.map((link) => link.goalId))].map(async (goalId) => {
          const goal = await this.input.projectManager!.store.getGoal(goalId);
          return [goalId, this.summarizeProjectGoal(goal)] as const;
        }),
      ),
    );
    const summariesByTaskId = new Map<string, Record<string, unknown>[]>();
    for (const link of links) {
      const summary = goalsById.get(link.goalId);
      if (!summary) {
        continue;
      }
      const summaries = summariesByTaskId.get(link.taskId) ?? [];
      if (!summaries.some((existing) => existing["id"] === summary["id"])) {
        summaries.push(summary);
      }
      summariesByTaskId.set(link.taskId, summaries);
    }
    return summariesByTaskId;
  }

  private async linkedTaskSummaries(
    taskLinks: ProjectGoalTaskLink[],
  ): Promise<Record<string, unknown>[] | undefined> {
    if (!this.input.taskTracker) {
      return undefined;
    }
    const linkedTasks = [];
    for (const link of taskLinks) {
      try {
        linkedTasks.push(summarizeTask(await this.input.taskTracker.getTask(link.taskId)));
      } catch (error) {
        if (error instanceof TaskNotFoundError) {
          continue;
        }
        throw error;
      }
    }
    return linkedTasks;
  }

  private summarizeProposal(
    task: TaskRecord,
    projectGoals: Record<string, unknown>[] = [],
  ): Record<string, unknown> {
    const proposal = task.proposal;
    return {
      ...summarizeTask(task),
      ...(projectGoals.length > 0 ? { projectGoals } : {}),
      proposal: proposal
        ? {
            supervisorStatus: proposal.supervisorStatus,
            approvalPolicy: proposal.approvalPolicy,
            autonomyLevel: proposal.autonomyLevel,
            proposedBy: proposal.proposedBy,
            proposalReason: proposal.proposalReason,
            policyDecision: proposal.policyEvaluation.decision,
            policyReason: proposal.policyEvaluation.reason,
            evidenceRefs: proposal.evidenceRefs,
            suggestedAcceptanceCriteria: proposal.suggestedAcceptanceCriteria,
            createdAt: proposal.createdAt,
          }
        : undefined,
    };
  }

  private buildTaskDetail(
    task: TaskRecord,
    leases: Awaited<ReturnType<TaskTrackerClient["listActiveLeases"]>>,
    allTasks: TaskRecord[],
  ): Record<string, unknown> {
    const taskLeases = leases.filter((lease) => lease.taskId === task.id);
    const childDependencies = task.dependencies.filter(
      (dependency) => dependency.kind === "parent_child" && dependency.fromTaskId === task.id,
    );
    const children = childDependencies
      .map((dependency) => {
        const child = allTasks.find((candidate) => candidate.id === dependency.toTaskId);
        return child
          ? {
              ...summarizeTask(child),
              dependencyReason: dependency.reason,
              externalMirrorStatus: child.externalRefs.length > 0 ? "mirrored" : "internal_only",
            }
          : undefined;
      })
      .filter(Boolean);
    const latestValidation = latestByCreatedAt(task.qualityGateRuns);
    const latestMr = latestByCreatedAt(task.mergeRequests);
    const failedRuns = task.agentRuns.filter((run) => run.status === "failed");

    return {
      task,
      summary: summarizeTask(
        task,
        taskLeases.find((lease) => lease.kind === "task")?.workerId,
      ),
      activeLeases: taskLeases,
      children,
      latestValidation,
      latestMergeRequest: latestMr,
      diagnostics: {
        failedRuns,
        latestFailure: [...failedRuns].sort((left, right) =>
          (right.completedAt ?? right.startedAt).localeCompare(
            left.completedAt ?? left.startedAt,
          ),
        )[0],
        repeatedValidationFailures:
          task.qualityGateRuns.filter((run) => run.status === "failed").length,
      },
    };
  }

  private buildOperationsSnapshot(
    tasks: TaskRecord[],
    leases: Awaited<ReturnType<TaskTrackerClient["listActiveLeases"]>>,
  ): Record<string, unknown> {
    const workerByTask = new Map(
      leases.filter((lease) => lease.kind === "task").map((lease) => [
        lease.taskId,
        lease.workerId,
      ]),
    );
    const taskLeaseByWorker = new Map<string, TaskLeaseRecord>();
    for (const lease of leases) {
      if (lease.kind === "task" && !taskLeaseByWorker.has(lease.workerId)) {
        taskLeaseByWorker.set(lease.workerId, lease);
      }
    }
    const queueDepth = new Map<string, number>();
    for (const task of tasks) {
      const key = JSON.stringify([
        task.repositoryName ?? "unassigned",
        task.queue ?? "unassigned",
        task.status,
        task.priority ?? "unassigned",
      ]);
      queueDepth.set(key, (queueDepth.get(key) ?? 0) + 1);
    }
    const failedTasks = tasks.filter((task) => task.status === "failed");
    const repeatedFailures = tasks.filter(
      (task) =>
        task.agentRuns.filter((run) => run.status === "failed").length > 1 ||
        task.qualityGateRuns.filter((run) => run.status === "failed").length > 1,
    );
    const waitingForHuman = tasks.filter((task) => task.status === "awaiting_human");
    const diagnosticTasks = new Map<string, TaskRecord>();
    for (const task of [...failedTasks, ...repeatedFailures, ...waitingForHuman]) {
      diagnosticTasks.set(task.id, task);
    }

    return {
      workers: this.input.state.listWorkers().map((worker) => {
        const taskLease = taskLeaseByWorker.get(worker.workerId);
        return {
          ...worker,
          ...(taskLease?.taskId ? { currentTaskId: taskLease.taskId } : {}),
          ...(worker.currentIssueKey ? { issueKey: worker.currentIssueKey } : {}),
          ...(worker.currentStage ? { stage: worker.currentStage } : {}),
          updatedAt: worker.lastHeartbeatAt,
        };
      }),
      leases,
      repositories: this.input.repositories(),
      queueDepth: [...queueDepth.entries()].map(([key, depth]) => {
        const [repositoryName, queue, status, priority] = JSON.parse(key) as string[];
        return { repositoryName, queue, status, priority, depth };
      }),
      failedTasks: failedTasks.map((task) => summarizeTask(task, workerByTask.get(task.id))),
      repeatedFailures: repeatedFailures.map((task) =>
        summarizeTask(task, workerByTask.get(task.id)),
      ),
      waitingForHuman: waitingForHuman.map((task) =>
        summarizeTask(task, workerByTask.get(task.id)),
      ),
      taskDiagnostics: [...diagnosticTasks.values()].map((task) =>
        this.buildOperationTaskDiagnostic(task),
      ),
      generatedAt: new Date().toISOString(),
    };
  }

  private buildOperationTaskDiagnostic(task: TaskRecord): Record<string, unknown> {
    const latestFailure = latestFailedAgentRun(task);
    const latestValidation = latestByCreatedAt(task.qualityGateRuns);
    const openQuestion = [...task.clarificationQuestions]
      .reverse()
      .find((question) => question.status === "open");

    return {
      taskId: task.id,
      repeatedValidationFailures:
        task.qualityGateRuns.filter((run) => run.status === "failed").length,
      failedAgentRuns: task.agentRuns.filter((run) => run.status === "failed").length,
      ...(latestFailure
        ? { latestFailedAgentRun: this.summarizeAgentRun(latestFailure) }
        : {}),
      ...(latestValidation
        ? { latestValidation: this.summarizeQualityGateRun(latestValidation) }
        : {}),
      ...(openQuestion
        ? {
            latestQuestion: {
              id: openQuestion.id,
              summary: openQuestion.question.summary,
              blockingReason: openQuestion.question.blockingReason,
              question: truncateDiagnostic(openQuestion.question.question),
              createdAt: openQuestion.createdAt,
            },
          }
        : {}),
      recentEvents: [...task.events]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 5)
        .map((event) => this.summarizeEvent(event)),
      updatedAt: task.updatedAt,
    };
  }

  private summarizeAgentRun(run: AgentRun): Record<string, unknown> {
    return {
      id: run.id,
      workerId: run.workerId,
      stage: run.stage,
      status: run.status,
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      ...(run.timedOut !== undefined ? { timedOut: run.timedOut } : {}),
      ...(truncateDiagnostic(run.finalMessage)
        ? { finalMessage: truncateDiagnostic(run.finalMessage) }
        : {}),
      ...(truncateDiagnostic(run.diagnostic)
        ? { diagnostic: truncateDiagnostic(run.diagnostic) }
        : {}),
      startedAt: run.startedAt,
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    };
  }

  private summarizeQualityGateRun(run: QualityGateRun): Record<string, unknown> {
    return {
      id: run.id,
      workerId: run.workerId,
      status: run.status,
      changed: run.changed,
      testsPassed: run.testsPassed,
      lintPassed: run.lintPassed,
      ...(truncateDiagnostic(run.summary) ? { summary: truncateDiagnostic(run.summary) } : {}),
      ...(truncateDiagnostic(run.diagnostic)
        ? { diagnostic: truncateDiagnostic(run.diagnostic) }
        : {}),
      createdAt: run.createdAt,
    };
  }

  private summarizeEvent(event: TaskEvent): Record<string, unknown> {
    return {
      id: event.id,
      kind: event.kind,
      source: event.source,
      ...(truncateDiagnostic(event.message) ? { message: truncateDiagnostic(event.message) } : {}),
      createdAt: event.createdAt,
    };
  }
}
