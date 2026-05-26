import {
  OperationsSnapshotDto,
  ProposalSummaryDto,
  ProjectGoalDetailResponseDto,
  ProjectGoalDto,
  ProjectGoalListResponseDto,
  SessionDto,
  TaskDetailDto,
  TaskDetailResponseDto,
  TaskSummaryDto,
} from '../models/human-api.dto';

const now = '2026-04-29T08:00:00.000Z';

export const viewerSession: SessionDto = {
  user: { id: 'viewer-1', displayName: 'Viewer One', service: 'human' },
  role: 'viewer',
  authMode: 'trusted_proxy',
  capabilities: {
    canReadTasks: true,
    canCreateTask: false,
    canUpdateTask: false,
    canAnswer: false,
    canResume: false,
    canCancel: false,
    canHold: false,
    canRetry: false,
    canForceReanalysis: false,
    canApproveProposal: false,
    canRejectProposal: false,
    canApproveDecomposition: false,
    canReadOperations: true,
    canCreateSystemTask: false,
  },
  apiPath: '/api',
  uiPath: '/tasks',
  generatedAt: now,
};

export const developerSession: SessionDto = {
  ...viewerSession,
  user: { id: 'dev-1', displayName: 'Developer One', service: 'human' },
  role: 'developer',
  capabilities: {
    ...viewerSession.capabilities,
    canCreateTask: true,
    canUpdateTask: true,
    canAnswer: true,
    canResume: true,
    canCancel: true,
    canApproveProposal: true,
    canRejectProposal: true,
    canApproveDecomposition: true,
  },
};

export const operatorSession: SessionDto = {
  ...developerSession,
  user: { id: 'ops-1', displayName: 'Operator One', service: 'human' },
  role: 'operator',
  capabilities: {
    ...developerSession.capabilities,
    canHold: true,
    canRetry: true,
    canForceReanalysis: true,
  },
};

export const readyTask: TaskSummaryDto = {
  id: 'ready-task',
  title: 'Implement ready queue item',
  status: 'ready',
  repositoryName: 'developer',
  repoPathKey: 'developer',
  queue: 'DEV',
  priority: 'normal',
  tags: ['ai_dev'],
  updatedAt: now,
};

export const draftTask: TaskSummaryDto = {
  ...readyTask,
  id: 'draft-task',
  title: 'Draft task',
  status: 'new',
};

export const awaitingHumanTask: TaskSummaryDto = {
  ...readyTask,
  id: 'awaiting-task',
  title: 'Need API decision',
  status: 'awaiting_human',
  activeWorker: 'worker-1',
  blockerReason: 'Variant is unclear.',
};

export const failedTask: TaskSummaryDto = {
  ...readyTask,
  id: 'failed-task',
  title: 'Fix validation failure',
  status: 'failed',
  latestValidationSummary: 'Unit tests failed.',
};

export const blockedTask: TaskSummaryDto = {
  ...readyTask,
  id: 'blocked-task',
  title: 'Blocked on external context',
  status: 'blocked',
  blockerReason: 'Missing credentials from operator.',
};

const detailTask = (summary: TaskSummaryDto, overrides: Partial<TaskDetailDto> = {}): TaskDetailDto => ({
  ...summary,
  description: `${summary.title} description.`,
  humanSummary: `${summary.title} summary.`,
  acceptanceCriteria: ['Expected behavior is implemented.'],
  constraints: [],
  riskFactors: [],
  missingContext: [],
  baseBranch: 'main',
  createdAt: now,
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
      createdAt: now,
    },
  ],
  ...overrides,
});

export const readyTaskDetail: TaskDetailResponseDto = {
  task: detailTask(readyTask),
  summary: readyTask,
  activeLeases: [],
  children: [],
  diagnostics: { repeatedValidationFailures: 0 },
};

export const awaitingTaskDetail: TaskDetailResponseDto = {
  task: detailTask(awaitingHumanTask, {
    clarificationQuestions: [
      {
        id: 'question-1',
        summary: 'Need API choice.',
        blockingReason: 'Variant is unclear.',
        question: 'Use v1 or v2?',
        options: ['v1', 'v2'],
        resumeHint: 'Reply with /resume.',
        createdAt: now,
      },
    ],
  }),
  summary: awaitingHumanTask,
  activeLeases: [
    {
      id: 'lease-1',
      kind: 'task',
      taskId: awaitingHumanTask.id,
      repositoryName: 'developer',
      workerId: 'worker-1',
      expiresAt: '2026-04-29T08:10:00.000Z',
    },
  ],
  children: [],
  diagnostics: { repeatedValidationFailures: 0 },
};

export const mrValidationTaskDetail: TaskDetailResponseDto = {
  task: detailTask({
    ...readyTask,
    id: 'mr-task',
    title: 'Task with MR and validation',
    mergeRequestUrl: 'https://gitlab.example/mr/1',
    branch: 'feature/mr-task',
    latestValidationSummary: 'Tests passed.',
  }),
  summary: {
    ...readyTask,
    id: 'mr-task',
    title: 'Task with MR and validation',
    mergeRequestUrl: 'https://gitlab.example/mr/1',
    branch: 'feature/mr-task',
    latestValidationSummary: 'Tests passed.',
  },
  activeLeases: [],
  children: [],
  latestValidation: {
    id: 'validation-1',
    workerId: 'worker-1',
    status: 'passed',
    summary: 'Tests passed.',
    createdAt: now,
  },
  latestMergeRequest: {
    id: 1,
    iid: 1,
    url: 'https://gitlab.example/mr/1',
    title: 'MR title',
    branch: 'feature/mr-task',
    outcome: 'created',
    createdAt: now,
  },
  diagnostics: { repeatedValidationFailures: 0 },
};

export const parentTaskDetail: TaskDetailResponseDto = {
  task: detailTask({
    ...readyTask,
    id: 'parent-task',
    title: 'Parent task',
  }),
  summary: {
    ...readyTask,
    id: 'parent-task',
    title: 'Parent task',
  },
  activeLeases: [],
  children: [
    {
      ...readyTask,
      id: 'child-task',
      title: 'Child task',
      dependencyReason: 'Split into child work.',
      externalMirrorStatus: 'internal_only',
    },
  ],
  diagnostics: { repeatedValidationFailures: 0 },
};

export const proposedTask: ProposalSummaryDto = {
  ...readyTask,
  id: 'proposal-task',
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
    createdAt: now,
  },
};

export const projectGoal: ProjectGoalDto = {
  id: 'pm_goal_1',
  sourceAnalysisId: 'analysis-1',
  sourceRunId: 'run-1',
  repositoryName: 'developer',
  title: 'Stabilize proposal workflow',
  problemStatement: 'Proposal review lacks goal traceability for project manager work.',
  desiredOutcome: 'Reviewers can see the project goal behind every generated proposal.',
  successMetrics: ['Goal context appears on proposal and task detail views.'],
  evidenceRefs: [
    {
      kind: 'analysis',
      ref: 'analysis-1',
      summary: 'PM analysis found missing traceability.',
    },
  ],
  status: 'proposed',
  priority: 'high',
  riskLevel: 'medium',
  suggestedTaskProposals: [
    {
      title: 'Show project goal context in proposals',
      description: 'Render parent project goal summaries in proposal review surfaces.',
      taskType: 'frontend_ui_fix',
      acceptanceCriteria: ['Proposal review shows the goal context.'],
      expectedBlastRadius: 'Angular console only.',
      evidenceRefs: [
        {
          kind: 'analysis',
          ref: 'analysis-1',
          summary: 'Proposal review needs goal context.',
        },
      ],
    },
  ],
  createdAt: now,
  updatedAt: now,
};

export const approvedProjectGoal: ProjectGoalDto = {
  ...projectGoal,
  id: 'pm_goal_approved',
  status: 'approved',
  approvedAt: '2026-04-29T08:03:00.000Z',
};

export const projectGoalList: ProjectGoalListResponseDto = {
  goals: [projectGoal, approvedProjectGoal],
  linkedTaskCounts: {
    [projectGoal.id]: 1,
    [approvedProjectGoal.id]: 0,
  },
  role: 'operator',
  generatedAt: now,
};

export const projectGoalDetail: ProjectGoalDetailResponseDto = {
  goal: projectGoal,
  auditEvents: [
    {
      id: 'goal-event-1',
      goalId: projectGoal.id,
      kind: 'goal_proposed',
      actor: { owner: 'agent', id: 'pm-agent', displayName: 'Project Manager' },
      message: 'Project goal proposed.',
      payload: { sourceAnalysisId: projectGoal.sourceAnalysisId },
      createdAt: now,
    },
  ],
  taskLinks: [
    {
      id: 'goal-task-link-1',
      goalId: projectGoal.id,
      taskId: readyTask.id,
      linkType: 'proposed_task',
      createdAt: now,
    },
  ],
  linkedTasks: [readyTask],
};

export const operationsSnapshot: OperationsSnapshotDto = {
  workers: [
    {
      workerId: 'worker-1',
      state: 'processing',
      repositoryName: 'developer',
      currentTaskId: 'awaiting-task',
      currentStage: 'implementation',
      startedAt: '2026-04-29T07:00:00.000Z',
      lastHeartbeatAt: now,
      updatedAt: now,
    },
  ],
  leases: awaitingTaskDetail.activeLeases,
  repositories: ['developer'],
  queueDepth: [{ repositoryName: 'developer', queue: 'DEV', status: 'ready', priority: 'normal', depth: 1 }],
  failedTasks: [failedTask],
  repeatedFailures: [failedTask],
  waitingForHuman: [awaitingHumanTask],
  taskDiagnostics: [
    {
      taskId: failedTask.id,
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
    {
      taskId: awaitingHumanTask.id,
      failedAgentRuns: 0,
      repeatedValidationFailures: 0,
      latestQuestion: {
        id: 'question-1',
        summary: 'Need API choice.',
        blockingReason: 'Variant is unclear.',
        question: 'Use v1 or v2?',
        createdAt: '2026-04-29T07:45:00.000Z',
      },
      recentEvents: [
        {
          id: 'event-waiting-1',
          kind: 'clarification_requested',
          source: 'worker_agent',
          message: 'Question sent to human.',
          createdAt: '2026-04-29T07:45:00.000Z',
        },
      ],
      updatedAt: awaitingHumanTask.updatedAt,
    },
  ],
  generatedAt: now,
};
