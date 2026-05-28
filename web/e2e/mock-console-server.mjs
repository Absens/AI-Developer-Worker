import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticRoot = resolve(__dirname, '..', 'dist', 'task-tracker-console', 'browser');
const port = Number(process.env.E2E_PORT || 4308);
const host = '127.0.0.1';
const now = () => new Date().toISOString();
const fixedNow = '2026-04-29T08:00:00.000Z';

const roleRank = { viewer: 0, developer: 1, operator: 2, admin: 3 };
const canRole = (role, minimum) => roleRank[role] >= roleRank[minimum];
const capabilitiesFor = (role, service = 'human') => ({
  canReadTasks: canRole(role, 'viewer'),
  canCreateTask: canRole(role, 'developer'),
  canUpdateTask: canRole(role, 'developer'),
  canAnswer: canRole(role, 'developer'),
  canResume: canRole(role, 'developer'),
  canCancel: canRole(role, 'developer'),
  canHold: canRole(role, 'operator'),
  canRetry: canRole(role, 'operator'),
  canForceReanalysis: canRole(role, 'operator'),
  canApproveProposal: canRole(role, 'developer'),
  canRejectProposal: canRole(role, 'developer'),
  canApproveDecomposition: canRole(role, 'developer'),
  canReadOperations: canRole(role, 'viewer'),
  canCreateSystemTask: service === 'system' && canRole(role, 'admin'),
  canReadProjectGoals: canRole(role, 'viewer'),
  canApproveProjectGoals: canRole(role, 'developer'),
  canRejectProjectGoals: canRole(role, 'developer'),
  canProposeProjectGoalTasks: canRole(role, 'operator'),
  canCompleteProjectGoals: canRole(role, 'developer'),
  canMarkProjectGoalsStale: canRole(role, 'developer'),
  canRunProjectManager: canRole(role, 'operator') || (service === 'system' && canRole(role, 'admin')),
});

const detailTask = (summary, overrides = {}) => ({
  ...summary,
  description: summary.description || `${summary.title} description.`,
  humanSummary: `${summary.title} summary.`,
  acceptanceCriteria: ['Expected behavior is implemented.'],
  constraints: [],
  riskFactors: [],
  missingContext: [],
  baseBranch: 'main',
  createdAt: fixedNow,
  createdBy: { owner: 'human', id: 'dev-1', displayName: 'Developer One' },
  clarificationQuestions: [],
  humanAnswers: [],
  comments: [],
  events: [
    {
      id: `event-${summary.id}`,
      kind: 'task_created',
      source: 'human',
      message: 'Task created.',
      createdAt: fixedNow,
    },
  ],
  ...overrides,
});

const baseSummary = {
  repositoryName: 'developer',
  repoPathKey: 'developer',
  queue: 'DEV',
  priority: 'normal',
  tags: ['ai_dev'],
  updatedAt: fixedNow,
};

const createInitialState = () => {
  const tasks = new Map();
  const projectGoals = new Map();
  const goalEvents = new Map();
  const goalTaskLinks = new Map();
  const put = (summary, overrides = {}) => {
    const task = detailTask({ ...baseSummary, ...summary }, overrides);
    tasks.set(task.id, task);
    return task;
  };
  const putGoal = (goal, events = []) => {
    projectGoals.set(goal.id, goal);
    goalEvents.set(goal.id, events);
    return goal;
  };

  put({ id: 'ready-task', title: 'Implement ready queue item', status: 'ready' });
  put({ id: 'draft-task', title: 'Draft task', status: 'new' });
  put(
    {
      id: 'awaiting-task',
      title: 'Need API decision',
      status: 'awaiting_human',
      activeWorker: 'worker-1',
      blockerReason: 'Variant is unclear.',
    },
    {
      clarificationQuestions: [
        {
          id: 'question-1',
          summary: 'Need API choice.',
          blockingReason: 'Variant is unclear.',
          question: 'Use v1 or v2?',
          options: ['v1', 'v2'],
          resumeHint: 'Reply with /resume.',
          createdAt: fixedNow,
        },
      ],
    },
  );
  put({
    id: 'failed-task',
    title: 'Fix validation failure',
    status: 'failed',
    latestValidationSummary: 'Unit tests failed.',
  });
  put({
    id: 'mr-task',
    title: 'Task with MR and validation',
    status: 'ready',
    mergeRequestUrl: 'https://gitlab.example/mr/1',
    branch: 'feature/mr-task',
    latestValidationSummary: 'Tests passed.',
  });
  put({
    id: 'long-title-task',
    title:
      'Review a very long task title that should wrap without overlapping action buttons or status tags in production layouts',
    status: 'ready',
  });
  put({
    id: 'proposal-approve-task',
    title: 'Document flaky tests',
    status: 'triage',
    proposal: {
      supervisorStatus: 'proposed',
      approvalPolicy: 'manual',
      autonomyLevel: 'proposal_only',
      proposedBy: 'agent-1',
      proposalReason: 'Repeated validation failures mention the same flaky test.',
      policyDecision: 'requires_approval',
      policyReason: 'Human review required for documentation task.',
      evidenceRefs: [
        {
          kind: 'validation_failure',
          ref: 'quality-gate:test:flaky-check',
          summary: 'Same test failed twice.',
        },
      ],
      suggestedAcceptanceCriteria: ['Runbook explains the flaky test flow.'],
      createdAt: fixedNow,
    },
  });
  put({
    id: 'proposal-reject-task',
    title: 'Risky schema rewrite proposal',
    status: 'triage',
    proposal: {
      supervisorStatus: 'proposed',
      approvalPolicy: 'manual',
      autonomyLevel: 'proposal_only',
      proposedBy: 'agent-2',
      proposalReason: 'Rewrite persistence tables without a migration plan.',
      policyDecision: 'requires_approval',
      policyReason: 'High blast radius needs human review.',
      evidenceRefs: [{ kind: 'file', ref: 'src/schema.ts', summary: 'Schema touched.' }],
      suggestedAcceptanceCriteria: ['Migration plan is explicit.'],
      createdAt: fixedNow,
    },
  });
  put({ id: 'parent-task', title: 'Parent task', status: 'ready' });
  put({ id: 'child-task', title: 'Child task', status: 'ready' });
  putGoal(
    {
      id: 'pm-goal-low-risk',
      sourceAnalysisId: 'analysis-pm-1',
      sourceRunId: 'pm-run-1',
      repositoryName: 'developer',
      title: 'Stabilize task intake',
      problemStatement: 'Incoming tasks need clearer triage guardrails before implementation work starts.',
      desiredOutcome: 'Low-risk intake checks are documented and visible to developers before queue execution.',
      successMetrics: [
        'New task proposals include explicit acceptance criteria.',
        'Operators can trace generated work back to the project goal.',
      ],
      evidenceRefs: [
        {
          kind: 'task',
          ref: 'ready-task',
          summary: 'Existing ready queue item shows the repository and queue conventions used by intake.',
        },
      ],
      status: 'proposed',
      priority: 'normal',
      riskLevel: 'low',
      suggestedTaskProposals: [
        {
          title: 'Goal-derived intake guardrails task',
          description: 'Document and validate low-risk task intake guardrails for the developer queue.',
          taskType: 'documentation',
          acceptanceCriteria: [
            'The guardrail checklist is available from the task description.',
            'The proposal remains in triage until a human approves it.',
          ],
          expectedBlastRadius: 'docs and queue metadata only',
          evidenceRefs: [{ kind: 'project_goal', ref: 'pm-goal-low-risk' }],
        },
      ],
      createdAt: fixedNow,
      updatedAt: fixedNow,
    },
    [
      {
        id: 'goal-event-pm-goal-low-risk-1',
        goalId: 'pm-goal-low-risk',
        kind: 'goal_proposed',
        actor: { owner: 'agent', id: 'project-manager', displayName: 'Project Manager' },
        message: 'Project Manager proposed a low-risk intake goal.',
        createdAt: fixedNow,
      },
    ],
  );

  return {
    tasks,
    projectGoals,
    projectAnalyses: [
      {
        id: 'pm-analysis-strategy-initial',
        repositoryName: 'developer',
        analysisKind: 'strategy',
        summary: 'Strategy summary.',
        strategy: {
          summary: 'Strategy summary.',
          analysisLenses: [{ lens: 'strategy', summary: 'Focus on validation trust.' }],
          opportunities: [
            {
              opportunityId: 'opp-validation',
              dimension: 'technical',
              title: 'Improve validation trust',
              problemStatement: 'Weak validation evidence.',
              userOrBusinessImpact: 'Operators lose confidence.',
              technicalImpact: 'Quality signals are weak.',
              evidenceRefs: [],
              confidence: 80,
              priority: 'high',
              riskLevel: 'medium',
              recommendedNextStep: 'create_goal',
              rationale: 'Mock evidence supports a narrow tests-only goal.',
              redTeamNotes: ['Keep scope narrow.'],
              architectVerdict: 'pursue',
            },
          ],
          goalLinks: [],
          questionsForHuman: [],
        },
        createdAt: now(),
      },
    ],
    goalEvents,
    goalTaskLinks,
    createdCount: 0,
    goalProposalCount: 0,
    failNextOperations: false,
  };
};

const state = createInitialState();

const json = (response, statusCode, body) => {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
};

const text = (response, statusCode, body, contentType = 'text/plain; charset=utf-8') => {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  response.end(body);
};

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
};

const header = (request, name) => {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const sessionFor = (request) => {
  const role = ['viewer', 'developer', 'operator', 'admin'].includes(
    String(header(request, 'x-task-tracker-role') || '').toLowerCase(),
  )
    ? String(header(request, 'x-task-tracker-role')).toLowerCase()
    : 'viewer';
  const authMode = ['trusted_proxy', 'bearer', 'localhost'].includes(
    String(header(request, 'x-e2e-auth-mode') || '').toLowerCase(),
  )
    ? String(header(request, 'x-e2e-auth-mode')).toLowerCase()
    : 'trusted_proxy';
  const service = authMode === 'localhost' ? 'localhost' : 'human';
  const user = header(request, 'x-task-tracker-user') || `${role}-1`;
  return {
    user: { id: user, displayName: user, service },
    role,
    authMode,
    capabilities: capabilitiesFor(role, service),
    apiPath: '/api',
    uiPath: '/tasks',
    generatedAt: now(),
  };
};

const summarize = (task) => ({
  id: task.id,
  title: task.title,
  status: task.status,
  repositoryName: task.repositoryName,
  repoPathKey: task.repoPathKey,
  queue: task.queue,
  priority: task.priority,
  activeWorker: task.activeWorker,
  blockerReason: task.blockerReason,
  latestAiSummary: task.latestAiSummary,
  latestValidationSummary: task.latestValidationSummary,
  mergeRequestUrl: task.mergeRequestUrl,
  branch: task.branch,
  tags: task.tags,
  updatedAt: task.updatedAt,
});

const summarizeProjectGoal = (goal) => ({
  id: goal.id,
  title: goal.title,
  status: goal.status,
  priority: goal.priority,
  riskLevel: goal.riskLevel,
  repositoryName: goal.repositoryName,
});

const projectGoalsForTask = (taskId) =>
  [...state.goalTaskLinks.values()]
    .filter((link) => link.taskId === taskId)
    .map((link) => state.projectGoals.get(link.goalId))
    .filter(Boolean)
    .map(summarizeProjectGoal);

const taskLinksForGoal = (goalId) =>
  [...state.goalTaskLinks.values()].filter((link) => link.goalId === goalId);

const linkedTasksForGoal = (goalId) =>
  taskLinksForGoal(goalId)
    .map((link) => state.tasks.get(link.taskId))
    .filter(Boolean)
    .map(summarize);

const linkedTaskCounts = () =>
  Object.fromEntries(
    [...state.projectGoals.keys()].map((goalId) => [goalId, taskLinksForGoal(goalId).length]),
  );

const projectGoalDetail = (goal) => ({
  goal,
  auditEvents: state.goalEvents.get(goal.id) || [],
  taskLinks: taskLinksForGoal(goal.id),
  linkedTasks: linkedTasksForGoal(goal.id),
});

const appendGoalEvent = (
  goalId,
  kind,
  message,
  actor = { owner: 'human', id: 'operator-1', displayName: 'operator-1' },
  payload,
) => {
  const events = state.goalEvents.get(goalId) || [];
  events.push({
    id: `goal-event-${goalId}-${events.length + 1}`,
    goalId,
    kind,
    actor,
    message,
    payload,
    createdAt: now(),
  });
  state.goalEvents.set(goalId, events);
};

const taskDetail = (task) => ({
  task,
  summary: summarize(task),
  activeLeases:
    task.id === 'awaiting-task'
      ? [
          {
            id: 'lease-1',
            kind: 'task',
            taskId: task.id,
            repositoryName: 'developer',
            workerId: 'worker-1',
            expiresAt: '2026-04-29T08:10:00.000Z',
          },
        ]
      : [],
  children:
    task.id === 'parent-task'
      ? [
          {
            ...summarize(state.tasks.get('child-task')),
            dependencyReason: 'Split into child work.',
            externalMirrorStatus: 'internal_only',
          },
        ]
      : [],
  latestValidation:
    task.id === 'mr-task'
      ? {
          id: 'validation-1',
          workerId: 'worker-1',
          status: 'passed',
          summary: 'Tests passed.',
          createdAt: fixedNow,
        }
      : undefined,
  latestMergeRequest:
    task.id === 'mr-task'
      ? {
          id: 1,
          iid: 1,
          url: 'https://gitlab.example/mr/1',
          title: 'MR title',
          branch: 'feature/mr-task',
          outcome: 'created',
          createdAt: fixedNow,
        }
      : undefined,
  diagnostics: { repeatedValidationFailures: task.id === 'failed-task' ? 2 : 0 },
  projectGoals: projectGoalsForTask(task.id),
});

const queueDepth = () => {
  const counts = new Map();
  for (const task of state.tasks.values()) {
    const key = JSON.stringify([
      task.repositoryName || 'unassigned',
      task.queue || 'unassigned',
      task.status,
      task.priority || 'unassigned',
    ]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, depth]) => {
    const [repositoryName, queue, status, priority] = JSON.parse(key);
    return { repositoryName, queue, status, priority, depth };
  });
};

const operationsSnapshot = () => {
  const failedTask = state.tasks.get('failed-task');
  const awaitingTask = state.tasks.get('awaiting-task');
  const failedTasks = failedTask?.status === 'failed' ? [summarize(failedTask)] : [];
  const waitingForHuman = awaitingTask?.status === 'awaiting_human' ? [summarize(awaitingTask)] : [];
  return {
    workers: [
      {
        workerId: 'worker-1',
        state: 'processing',
        repositoryName: 'developer',
        currentTaskId: awaitingTask?.status === 'awaiting_human' ? 'awaiting-task' : undefined,
        currentStage: 'implementation',
        startedAt: '2026-04-29T07:00:00.000Z',
        lastHeartbeatAt: fixedNow,
        updatedAt: fixedNow,
      },
    ],
    leases: waitingForHuman.length
      ? [
          {
            id: 'lease-1',
            kind: 'task',
            taskId: 'awaiting-task',
            repositoryName: 'developer',
            workerId: 'worker-1',
            expiresAt: '2026-04-29T08:10:00.000Z',
          },
        ]
      : [],
    repositories: ['developer'],
    queueDepth: queueDepth(),
    failedTasks,
    repeatedFailures: failedTasks,
    waitingForHuman,
    taskDiagnostics: [
      ...(failedTasks.length
        ? [
            {
              taskId: 'failed-task',
              failedAgentRuns: 2,
              repeatedValidationFailures: 2,
              latestFailedAgentRun: {
                id: 'run-1',
                workerId: 'worker-1',
                stage: 'implementation',
                status: 'failed',
                exitCode: 1,
                diagnostic: 'Codex implementation failed after the validation command.',
                startedAt: '2026-04-29T07:30:00.000Z',
                completedAt: '2026-04-29T07:40:00.000Z',
              },
              latestValidation: {
                id: 'validation-ops-1',
                workerId: 'worker-1',
                status: 'failed',
                changed: true,
                testsPassed: false,
                lintPassed: true,
                summary: 'Unit tests failed.',
                diagnostic: 'Expected queue refresh to keep stale data visible.',
                createdAt: '2026-04-29T07:42:00.000Z',
              },
              recentEvents: [
                {
                  id: 'event-failed-1',
                  kind: 'validation_recorded',
                  source: 'worker_agent',
                  message: 'Validation failed.',
                  createdAt: '2026-04-29T07:42:00.000Z',
                },
              ],
              updatedAt: failedTask.updatedAt,
            },
          ]
        : []),
      ...(waitingForHuman.length
        ? [
            {
              taskId: 'awaiting-task',
              failedAgentRuns: 0,
              repeatedValidationFailures: 0,
              latestQuestion: {
                id: 'question-1',
                summary: 'Need API choice.',
                blockingReason: 'Variant is unclear.',
                question: 'Use v1 or v2?',
                createdAt: '2026-04-29T07:45:00.000Z',
              },
              recentEvents: [],
              updatedAt: awaitingTask.updatedAt,
            },
          ]
        : []),
    ],
    generatedAt: fixedNow,
  };
};

const hasRequiredRole = (request, minimum) =>
  canRole(sessionFor(request).role, minimum);

const handleApi = async (request, response, url) => {
  const path = url.pathname;
  if (path === '/api/session' && request.method === 'GET') {
    json(response, 200, sessionFor(request));
    return;
  }
  if (path === '/api/e2e/fail-next-operations' && request.method === 'POST') {
    state.failNextOperations = true;
    json(response, 200, { ok: true });
    return;
  }
  if (path === '/api/tasks' && request.method === 'GET') {
    const statuses = url.searchParams.getAll('status');
    const tasks = [...state.tasks.values()]
      .filter((task) => !statuses.length || statuses.includes(task.status))
      .filter((task) => {
        const repository = url.searchParams.get('repository');
        return !repository || task.repositoryName === repository;
      })
      .map(summarize);
    json(response, 200, { tasks, role: sessionFor(request).role, generatedAt: now() });
    return;
  }
  if (path === '/api/tasks' && request.method === 'POST') {
    if (!hasRequiredRole(request, 'developer')) {
      json(response, 403, { status: 'error', error: 'forbidden' });
      return;
    }
    const body = await readBody(request);
    state.createdCount += 1;
    const id = body.status === 'ready' ? `created-ready-${state.createdCount}` : `created-draft-${state.createdCount}`;
    const task = detailTask({
      ...baseSummary,
      id,
      title: body.title,
      description: body.description,
      status: body.status || 'new',
      repositoryName: body.repositoryName || 'developer',
      repoPathKey: body.repoPathKey || 'developer',
      queue: body.queue || 'DEV',
      priority: body.priority || 'normal',
      tags: Array.isArray(body.tags) ? body.tags : ['ai_dev'],
      acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : [],
      updatedAt: now(),
    });
    state.tasks.set(id, task);
    json(response, 201, { task, idempotent: false });
    return;
  }
  if (path === '/api/proposals' && request.method === 'GET') {
    const supervisorStatus = url.searchParams.get('supervisorStatus');
    const proposals = [...state.tasks.values()]
      .filter((task) => task.proposal)
      .filter((task) => !supervisorStatus || task.proposal.supervisorStatus === supervisorStatus)
      .map((task) => ({
        ...summarize(task),
        proposal: task.proposal,
        projectGoals: projectGoalsForTask(task.id),
      }));
    json(response, 200, {
      proposals,
      role: sessionFor(request).role,
      generatedAt: now(),
    });
    return;
  }
  if (path === '/api/project-goals' && request.method === 'GET') {
    const statuses = url.searchParams.getAll('status');
    const repositoryName = url.searchParams.get('repositoryName');
    const goals = [...state.projectGoals.values()]
      .filter((goal) => !statuses.length || statuses.includes(goal.status))
      .filter((goal) => !repositoryName || goal.repositoryName === repositoryName);
    json(response, 200, {
      goals,
      linkedTaskCounts: linkedTaskCounts(),
      role: sessionFor(request).role,
      generatedAt: now(),
    });
    return;
  }
  if (path === '/api/project-manager/analyses' && request.method === 'GET') {
    const repositoryName = url.searchParams.get('repositoryName');
    const analysisKind = url.searchParams.get('analysisKind');
    const analyses = state.projectAnalyses.filter(
      (analysis) =>
        (!repositoryName || analysis.repositoryName === repositoryName) &&
        (!analysisKind || analysis.analysisKind === analysisKind),
    );
    json(response, 200, { analyses });
    return;
  }
  if (path === '/api/project-manager/runs' && request.method === 'POST') {
    if (!hasRequiredRole(request, 'operator')) {
      json(response, 403, { status: 'error', error: 'forbidden' });
      return;
    }
    const body = await readBody(request);
    if (body.mode === 'strategy') {
      const goal = {
        id: `pm-goal-strategy-${state.projectGoals.size + 1}`,
        sourceAnalysisId: `pm-analysis-strategy-${Date.now()}`,
        sourceRunId: `pm-run-strategy-${Date.now()}`,
        repositoryName: body.repositoryName || 'developer',
        title: 'Improve validation trust',
        problemStatement: 'No-op validation can be treated as strong evidence.',
        desiredOutcome: 'PM prompts distinguish weak validation evidence.',
        successMetrics: ['Prompt tests cover no-op validation commands.'],
        evidenceRefs: [
          { kind: 'snapshot', ref: 'projectSignals.failedTasks', summary: 'Failed tasks exist.' },
        ],
        status: 'proposed',
        priority: 'high',
        riskLevel: 'medium',
        suggestedTaskProposals: [],
        createdAt: now(),
        updatedAt: now(),
      };
      state.projectGoals.set(goal.id, goal);
      const analysis = {
        id: goal.sourceAnalysisId,
        repositoryName: goal.repositoryName,
        analysisKind: 'strategy',
        summary: 'Strategy identified validation trust as a high-confidence opportunity.',
        strategy: {
          summary: 'Strategy identified validation trust as a high-confidence opportunity.',
          analysisLenses: [{ lens: 'architecture', summary: 'Tests-only scope is feasible.' }],
          opportunities: [
            {
              opportunityId: 'opp-validation',
              dimension: 'technical',
              title: 'Improve validation trust',
              problemStatement: goal.problemStatement,
              userOrBusinessImpact: 'Operators lose confidence.',
              technicalImpact: 'Quality signals are weak.',
              evidenceRefs: goal.evidenceRefs,
              confidence: 82,
              priority: 'high',
              riskLevel: 'medium',
              recommendedNextStep: 'create_goal',
              rationale: 'Mock strategy run found bounded evidence.',
              redTeamNotes: ['Avoid broad CI rewrites.'],
              architectVerdict: 'pursue',
            },
          ],
          goalLinks: [
            {
              sourceOpportunityId: 'opp-validation',
              proposedGoalTitle: goal.title,
              evidenceRefs: goal.evidenceRefs,
            },
          ],
          questionsForHuman: [],
        },
        createdAt: now(),
      };
      state.projectAnalyses.unshift(analysis);
      json(response, 200, {
        result: {
          run: {
            id: goal.sourceRunId,
            repositoryName: goal.repositoryName,
            trigger: 'manual',
            mode: 'strategy',
            status: 'completed',
            analysisId: analysis.id,
            proposedGoalIds: [goal.id],
            proposedTaskIds: [],
            startedAt: now(),
            completedAt: now(),
          },
          analysis,
          strategy: analysis.strategy,
        },
      });
      return;
    }
    if (body.mode === 'replan') {
      const replanReason = typeof body.replanReason === 'string' ? body.replanReason.trim() : '';
      if (!replanReason) {
        json(response, 400, { status: 'error', error: 'replanReason is required' });
        return;
      }
      const run = {
        id: `pm-run-replan-${Date.now()}`,
        repositoryName: body.repositoryName || 'developer',
        mode: 'replan',
        status: 'completed',
        createdAt: now(),
        completedAt: now(),
      };
      const analysis = {
        id: `analysis-replan-${Date.now()}`,
        runId: run.id,
        repositoryName: run.repositoryName,
        status: 'classified',
        projectGoalId: 'pm-goal-low-risk',
        decision: 'create_follow_up',
        rationale: 'Mock replan found a smaller follow-up after linked task status changed.',
        createdAt: now(),
      };
      const goal = state.projectGoals.get('pm-goal-low-risk');
      if (goal) {
        goal.sourceRunId = run.id;
        goal.sourceAnalysisId = analysis.id;
        goal.updatedAt = now();
      }
      appendGoalEvent(
        'pm-goal-low-risk',
        'project_goal_replan_classified',
        replanReason,
        { owner: 'human', id: 'operator-1', displayName: 'operator-1' },
        {
          decision: 'create_follow_up',
          rationale: 'Mock replan found a smaller follow-up after linked task status changed.',
        },
      );
      json(response, 202, {
        result: {
          run,
          analysis,
        },
      });
      return;
    }
    json(response, 202, {
      run: {
        id: `pm-run-${Date.now()}`,
        repositoryName: body.repositoryName || 'developer',
        status: 'queued',
        createdAt: now(),
      },
    });
    return;
  }
  if (path === '/api/operations' && request.method === 'GET') {
    if (state.failNextOperations) {
      state.failNextOperations = false;
      json(response, 503, { status: 'error', error: 'backend unavailable' });
      return;
    }
    json(response, 200, operationsSnapshot());
    return;
  }

  const goalMatch = path.match(/^\/api\/project-goals\/([^/]+)(.*)$/);
  if (goalMatch) {
    const goalId = decodeURIComponent(goalMatch[1]);
    const suffix = goalMatch[2] || '';
    const goal = state.projectGoals.get(goalId);
    if (!goal) {
      json(response, 404, { status: 'error', error: 'project goal not found' });
      return;
    }
    if (request.method === 'GET' && suffix === '') {
      json(response, 200, projectGoalDetail(goal));
      return;
    }
    const commandMatch = suffix.match(/^\/commands\/([^/]+)$/);
    if (request.method === 'POST' && commandMatch) {
      const command = commandMatch[1];
      const minimum = command === 'propose-tasks' ? 'operator' : 'developer';
      if (!hasRequiredRole(request, minimum)) {
        json(response, 403, { status: 'error', error: 'forbidden' });
        return;
      }
      const body = await readBody(request);
      if (command === 'approve') {
        goal.status = 'approved';
        goal.approvedAt = now();
        goal.updatedAt = goal.approvedAt;
        appendGoalEvent(goal.id, 'goal_approved', 'Project goal approved.');
        json(response, 200, { goal });
        return;
      }
      if (command === 'reject') {
        goal.status = 'rejected';
        goal.rejectedAt = now();
        goal.rejectionReason = body.reason || 'Rejected during e2e review.';
        goal.updatedAt = goal.rejectedAt;
        appendGoalEvent(goal.id, 'goal_rejected', goal.rejectionReason);
        json(response, 200, { goal });
        return;
      }
      if (command === 'propose-tasks') {
        state.goalProposalCount += 1;
        const taskId = `pm-goal-task-${goal.id}-${state.goalProposalCount}`;
        let task = state.tasks.get(taskId);
        if (!task) {
          const draft = goal.suggestedTaskProposals[0] || {
            title: `Task for ${goal.title}`,
            description: goal.desiredOutcome,
            taskType: 'documentation',
            acceptanceCriteria: goal.successMetrics,
            evidenceRefs: goal.evidenceRefs,
          };
          task = detailTask({
            ...baseSummary,
            id: taskId,
            title: draft.title,
            description: draft.description,
            humanSummary: `Project goal work for ${goal.title}.`,
            status: 'triage',
            repositoryName: goal.repositoryName,
            repoPathKey: goal.repositoryName,
            queue: 'DEV',
            priority: goal.priority,
            tags: ['ai_dev', 'project_goal'],
            acceptanceCriteria: draft.acceptanceCriteria,
            updatedAt: now(),
            proposal: {
              supervisorStatus: 'proposed',
              approvalPolicy: 'manual',
              autonomyLevel: 'proposal_only',
              proposedBy: 'project-manager',
              proposalReason: `Project goal "${goal.title}" recommends this low-risk follow-up.`,
              policyDecision: 'requires_approval',
              policyReason: 'Goal-derived work must remain a proposal until a human approves it.',
              evidenceRefs: draft.evidenceRefs,
              suggestedAcceptanceCriteria: draft.acceptanceCriteria,
              createdAt: now(),
            },
          });
          state.tasks.set(task.id, task);
        }
        if (!taskLinksForGoal(goal.id).some((link) => link.taskId === task.id)) {
          const link = {
            id: `goal-link-${goal.id}-${task.id}`,
            goalId: goal.id,
            taskId: task.id,
            linkType: 'proposed_task',
            createdAt: now(),
          };
          state.goalTaskLinks.set(link.id, link);
        }
        goal.status = 'active';
        goal.activatedAt ||= now();
        goal.updatedAt = now();
        appendGoalEvent(goal.id, 'tasks_proposed', `Proposed task ${task.id} from project goal.`);
        json(response, 200, {
          goal,
          tasks: [],
          proposals: [{ ...summarize(task), proposal: task.proposal, projectGoals: projectGoalsForTask(task.id) }],
          taskLinks: taskLinksForGoal(goal.id),
        });
        return;
      }
      if (command === 'complete') {
        goal.status = 'completed';
        goal.completedAt = now();
        goal.updatedAt = goal.completedAt;
        appendGoalEvent(goal.id, 'goal_completed', 'Project goal completed.');
        json(response, 200, { goal });
        return;
      }
      if (command === 'stale') {
        goal.status = 'stale';
        goal.staleAt = now();
        goal.staleReason = body.reason || 'Marked stale during e2e review.';
        goal.updatedAt = goal.staleAt;
        appendGoalEvent(goal.id, 'goal_marked_stale', goal.staleReason);
        json(response, 200, { goal });
        return;
      }
      json(response, 404, { status: 'error', error: 'unknown project goal command' });
      return;
    }
    text(response, 404, 'not found');
    return;
  }

  const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(.*)$/);
  if (!taskMatch) {
    text(response, 404, 'not found');
    return;
  }
  const taskId = decodeURIComponent(taskMatch[1]);
  const suffix = taskMatch[2] || '';
  const task = state.tasks.get(taskId);
  if (!task) {
    json(response, 404, { status: 'error', error: 'task not found' });
    return;
  }
  if (request.method === 'GET' && suffix === '') {
    json(response, 200, taskDetail(task));
    return;
  }
  if (request.method === 'GET' && suffix === '/agent-context-preview') {
    json(response, 200, {
      agentContext: {
        taskId: task.id,
        status: task.status,
        title: task.title,
        description: task.description,
        repositoryName: task.repositoryName,
        repoPathKey: task.repoPathKey,
        baseBranch: task.baseBranch,
        queue: task.queue,
        priority: task.priority,
        tags: task.tags,
        acceptanceCriteria: task.acceptanceCriteria,
        events: task.events,
      },
    });
    return;
  }
  if (request.method === 'POST' && suffix === '/answers') {
    if (!hasRequiredRole(request, 'developer')) {
      json(response, 403, { status: 'error', error: 'forbidden' });
      return;
    }
    const body = await readBody(request);
    task.humanAnswers.push({
      id: `answer-${task.humanAnswers.length + 1}`,
      questionId: body.questionId,
      body: body.body,
      command: body.command,
      createdAt: now(),
    });
    if (body.command?.type === 'resume') {
      task.status = 'ready';
      task.updatedAt = now();
    }
    json(response, 200, { task });
    return;
  }
  const commandMatch = suffix.match(/^\/commands\/([^/]+)$/);
  if (request.method === 'POST' && commandMatch) {
    const command = commandMatch[1];
    const minimum = ['hold', 'retry', 'force-reanalysis'].includes(command)
      ? 'operator'
      : 'developer';
    if (!hasRequiredRole(request, minimum)) {
      json(response, 403, { status: 'error', error: 'forbidden' });
      return;
    }
    await readBody(request);
    if (command === 'mark-ready' || command === 'resume' || command === 'retry') {
      task.status = 'ready';
    }
    if (command === 'hold') {
      task.status = 'blocked';
    }
    if (command === 'cancel') {
      task.status = 'cancelled';
    }
    if (command === 'approve-proposal' && task.proposal) {
      task.proposal.supervisorStatus = 'approved';
      task.status = 'ready';
    }
    if (command === 'reject-proposal' && task.proposal) {
      task.proposal.supervisorStatus = 'rejected';
    }
    task.updatedAt = now();
    json(response, 200, { task });
    return;
  }
  text(response, 404, 'not found');
};

const contentTypeFor = (filePath) => {
  switch (extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.ico':
      return 'image/x-icon';
    case '.png':
      return 'image/png';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
};

const inside = (root, candidate) => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const serveStatic = async (path, response) => {
  const relativePath = path === '/tasks' ? '' : decodeURIComponent(path.slice('/tasks/'.length));
  const indexPath = join(staticRoot, 'index.html');
  const candidate = relativePath ? resolve(staticRoot, relativePath) : indexPath;
  if (!inside(staticRoot, candidate)) {
    text(response, 400, 'invalid path');
    return;
  }
  try {
    const fileStat = await stat(candidate);
    if (fileStat.isFile()) {
      response.writeHead(200, {
        'content-type': contentTypeFor(candidate),
        'cache-control': extname(candidate) === '.html' ? 'no-store' : 'public, max-age=300',
      });
      response.end(await readFile(candidate));
      return;
    }
  } catch {
    if (path.startsWith('/tasks/assets/') || extname(relativePath)) {
      text(response, 404, 'Angular static asset not found.');
      return;
    }
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(await readFile(indexPath));
};

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${host}:${port}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(request, response, url).catch((error) => {
      json(response, 500, { status: 'error', error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (url.pathname === '/healthz') {
    json(response, 200, { status: 'ok' });
    return;
  }
  if (url.pathname === '/readyz') {
    json(response, 200, { status: 'ok' });
    return;
  }
  if (url.pathname === '/metrics') {
    text(response, 200, '# mock metrics\n', 'text/plain; version=0.0.4; charset=utf-8');
    return;
  }
  if (url.pathname === '/tasks' || url.pathname.startsWith('/tasks/')) {
    serveStatic(url.pathname, response).catch((error) => {
      text(response, 500, error instanceof Error ? error.message : String(error));
    });
    return;
  }
  text(response, 404, 'not found');
});

server.listen(port, host, () => {
  console.log(`E2E mock console server listening at http://${host}:${port}/tasks`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
