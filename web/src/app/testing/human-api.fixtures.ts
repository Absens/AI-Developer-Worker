import {
  OperationsSnapshotDto,
  ProposalSummaryDto,
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

export const operationsSnapshot: OperationsSnapshotDto = {
  workers: [{ workerId: 'worker-1', state: 'idle', repositoryName: 'developer', updatedAt: now }],
  leases: awaitingTaskDetail.activeLeases,
  repositories: ['developer'],
  queueDepth: [{ repositoryName: 'developer', queue: 'DEV', status: 'ready', depth: 1 }],
  failedTasks: [failedTask],
  repeatedFailures: [failedTask],
  waitingForHuman: [awaitingHumanTask],
  generatedAt: now,
};
