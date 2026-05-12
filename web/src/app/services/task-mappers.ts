import {
  ActorDto,
  ChildTaskSummaryDto,
  ClarificationQuestionDto,
  CommandResponseDto,
  CreateTaskResponseDto,
  HumanAnswerDto,
  LeaseDto,
  MergeRequestSummaryDto,
  OperationAgentRunSummaryDto,
  OperationEventSummaryDto,
  OperationQuestionSummaryDto,
  OperationTaskDiagnosticDto,
  OperationValidationSummaryDto,
  OperationsSnapshotDto,
  ProposalListResponseDto,
  ProposalSummaryDto,
  QueueDepthDto,
  TaskCommentDto,
  TaskConversationResponseDto,
  TaskDetailDto,
  TaskDetailResponseDto,
  TaskDiagnosticsDto,
  TaskListResponseDto,
  TaskStatusDto,
  TaskSummaryDto,
  TimelineEventDto,
  ValidationSummaryDto,
  WorkerSnapshotDto,
} from '../models/human-api.dto';

type RawRecord = Record<string, unknown>;

const record = (value: unknown): RawRecord =>
  typeof value === 'object' && value !== null ? (value as RawRecord) : {};

const stringValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const numberOrString = (value: unknown): string | number | undefined =>
  typeof value === 'string' || typeof value === 'number' ? value : undefined;

const optionalString = (value: unknown): string | undefined => {
  const parsed = stringValue(value).trim();
  return parsed || undefined;
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const records = (value: unknown): RawRecord[] =>
  Array.isArray(value) ? value.map(record) : [];

export const mapActor = (value: unknown): ActorDto | undefined => {
  const raw = record(value);
  const id = optionalString(raw['id']);
  const owner = optionalString(raw['owner']);
  if (!id || !owner) {
    return undefined;
  }
  return {
    owner,
    id,
    ...(optionalString(raw['displayName']) ? { displayName: optionalString(raw['displayName']) } : {}),
  };
};

export const mapTaskSummary = (value: unknown): TaskSummaryDto => {
  const raw = record(value);
  return {
    id: stringValue(raw['id']),
    title: stringValue(raw['title']),
    status: stringValue(raw['status'], 'new') as TaskStatusDto,
    ...(optionalString(raw['repositoryName'])
      ? { repositoryName: optionalString(raw['repositoryName']) }
      : {}),
    ...(optionalString(raw['repoPathKey']) ? { repoPathKey: optionalString(raw['repoPathKey']) } : {}),
    ...(optionalString(raw['queue']) ? { queue: optionalString(raw['queue']) } : {}),
    ...(optionalString(raw['priority']) ? { priority: optionalString(raw['priority']) } : {}),
    ...(optionalString(raw['activeWorker']) ? { activeWorker: optionalString(raw['activeWorker']) } : {}),
    ...(optionalString(raw['blockerReason'])
      ? { blockerReason: optionalString(raw['blockerReason']) }
      : {}),
    ...(optionalString(raw['latestAiSummary'])
      ? { latestAiSummary: optionalString(raw['latestAiSummary']) }
      : {}),
    ...(optionalString(raw['latestValidationSummary'])
      ? { latestValidationSummary: optionalString(raw['latestValidationSummary']) }
      : {}),
    ...(optionalString(raw['mergeRequestUrl'])
      ? { mergeRequestUrl: optionalString(raw['mergeRequestUrl']) }
      : {}),
    ...(optionalString(raw['branch']) ? { branch: optionalString(raw['branch']) } : {}),
    ...(Array.isArray(raw['tags']) ? { tags: stringArray(raw['tags']) } : {}),
    updatedAt: stringValue(raw['updatedAt']),
  };
};

export const mapLease = (value: unknown): LeaseDto => {
  const raw = record(value);
  return {
    id: stringValue(raw['id'] ?? raw['leaseKey']),
    kind: stringValue(raw['kind']),
    ...(optionalString(raw['taskId']) ? { taskId: optionalString(raw['taskId']) } : {}),
    ...(optionalString(raw['repositoryName'])
      ? { repositoryName: optionalString(raw['repositoryName']) }
      : {}),
    workerId: stringValue(raw['workerId']),
    expiresAt: stringValue(raw['expiresAt']),
    ...(optionalString(raw['heartbeatAt']) ? { heartbeatAt: optionalString(raw['heartbeatAt']) } : {}),
    ...(optionalString(raw['releasedAt']) ? { releasedAt: optionalString(raw['releasedAt']) } : {}),
  };
};

export const mapValidation = (value: unknown): ValidationSummaryDto | undefined => {
  if (!value) {
    return undefined;
  }
  const raw = record(value);
  return {
    ...(optionalString(raw['id']) ? { id: optionalString(raw['id']) } : {}),
    ...(optionalString(raw['workerId']) ? { workerId: optionalString(raw['workerId']) } : {}),
    status: stringValue(raw['status']),
    ...(optionalString(raw['summary']) ? { summary: optionalString(raw['summary']) } : {}),
    ...(optionalString(raw['diagnostic']) ? { diagnostic: optionalString(raw['diagnostic']) } : {}),
    ...(optionalString(raw['startedAt']) ? { startedAt: optionalString(raw['startedAt']) } : {}),
    ...(optionalString(raw['completedAt']) ? { completedAt: optionalString(raw['completedAt']) } : {}),
    createdAt: stringValue(raw['createdAt']),
  };
};

export const mapMergeRequest = (value: unknown): MergeRequestSummaryDto | undefined => {
  if (!value) {
    return undefined;
  }
  const raw = record(value);
  const mergeRequest = record(raw['mergeRequest']);
  return {
    ...(numberOrString(raw['id'] ?? mergeRequest['id']) !== undefined
      ? { id: numberOrString(raw['id'] ?? mergeRequest['id']) }
      : {}),
    ...(numberOrString(raw['iid'] ?? mergeRequest['iid']) !== undefined
      ? { iid: numberOrString(raw['iid'] ?? mergeRequest['iid']) }
      : {}),
    ...(optionalString(raw['url'] ?? mergeRequest['url'])
      ? { url: optionalString(raw['url'] ?? mergeRequest['url']) }
      : {}),
    ...(optionalString(raw['title'] ?? mergeRequest['title'])
      ? { title: optionalString(raw['title'] ?? mergeRequest['title']) }
      : {}),
    ...(optionalString(raw['branch']) ? { branch: optionalString(raw['branch']) } : {}),
    ...(optionalString(raw['sourceBranch'] ?? mergeRequest['sourceBranch'])
      ? { sourceBranch: optionalString(raw['sourceBranch'] ?? mergeRequest['sourceBranch']) }
      : {}),
    ...(optionalString(raw['targetBranch'] ?? mergeRequest['targetBranch'])
      ? { targetBranch: optionalString(raw['targetBranch'] ?? mergeRequest['targetBranch']) }
      : {}),
    ...(optionalString(raw['outcome']) ? { outcome: optionalString(raw['outcome']) } : {}),
    createdAt: stringValue(raw['createdAt']),
  };
};

export const mapQuestion = (value: unknown): ClarificationQuestionDto => {
  const raw = record(value);
  const question = record(raw['question']);
  return {
    id: stringValue(raw['id']),
    ...(optionalString(raw['summary'] ?? question['summary'])
      ? { summary: optionalString(raw['summary'] ?? question['summary']) }
      : {}),
    ...(optionalString(raw['blockingReason'] ?? question['blockingReason'])
      ? { blockingReason: optionalString(raw['blockingReason'] ?? question['blockingReason']) }
      : {}),
    question: stringValue(typeof raw['question'] === 'string' ? raw['question'] : question['question']),
    ...(Array.isArray(raw['options'] ?? question['options'])
      ? { options: stringArray(raw['options'] ?? question['options']) }
      : {}),
    ...(optionalString(raw['resumeHint'] ?? question['resumeHint'])
      ? { resumeHint: optionalString(raw['resumeHint'] ?? question['resumeHint']) }
      : {}),
    createdAt: stringValue(raw['createdAt']),
  };
};

export const mapAnswer = (value: unknown): HumanAnswerDto => {
  const raw = record(value);
  return {
    id: stringValue(raw['id']),
    ...(optionalString(raw['questionId']) ? { questionId: optionalString(raw['questionId']) } : {}),
    ...(mapActor(raw['author']) ? { author: mapActor(raw['author']) } : {}),
    body: stringValue(raw['body']),
    ...(raw['command'] !== undefined ? { command: raw['command'] } : {}),
    createdAt: stringValue(raw['createdAt']),
  };
};

export const mapComment = (value: unknown): TaskCommentDto => {
  const raw = record(value);
  return {
    id: stringValue(raw['id']),
    ...(mapActor(raw['author']) ? { author: mapActor(raw['author']) } : {}),
    body: stringValue(raw['body'] ?? raw['text']),
    createdAt: stringValue(raw['createdAt']),
  };
};

export const mapEvent = (value: unknown): TimelineEventDto => {
  const raw = record(value);
  return {
    ...(optionalString(raw['id']) ? { id: optionalString(raw['id']) } : {}),
    kind: stringValue(raw['kind']),
    ...(optionalString(raw['source']) ? { source: optionalString(raw['source']) } : {}),
    ...(mapActor(raw['actor']) ? { actor: mapActor(raw['actor']) } : {}),
    ...(optionalString(raw['message']) ? { message: optionalString(raw['message']) } : {}),
    createdAt: stringValue(raw['createdAt']),
  };
};

export const mapTaskDetail = (value: unknown, summary?: TaskSummaryDto): TaskDetailDto => {
  const raw = record(value);
  const base = { ...mapTaskSummary(raw), ...summary };
  return {
    ...base,
    description: stringValue(raw['description']),
    ...(optionalString(raw['humanSummary']) ? { humanSummary: optionalString(raw['humanSummary']) } : {}),
    acceptanceCriteria: stringArray(raw['acceptanceCriteria']),
    constraints: stringArray(raw['constraints']),
    riskFactors: stringArray(raw['riskFactors']),
    missingContext: stringArray(raw['missingContext']),
    ...(optionalString(raw['baseBranch']) ? { baseBranch: optionalString(raw['baseBranch']) } : {}),
    ...(optionalString(raw['businessStatus'])
      ? { businessStatus: optionalString(raw['businessStatus']) }
      : {}),
    createdAt: stringValue(raw['createdAt']),
    ...(mapActor(raw['createdBy']) ? { createdBy: mapActor(raw['createdBy']) } : {}),
    clarificationQuestions: records(raw['clarificationQuestions']).map(mapQuestion),
    humanAnswers: records(raw['humanAnswers']).map(mapAnswer),
    comments: records(raw['comments']).map(mapComment),
    events: records(raw['events']).map(mapEvent),
  };
};

export const mapTaskListResponse = (value: unknown): TaskListResponseDto => {
  const raw = record(value);
  return {
    tasks: records(raw['tasks']).map(mapTaskSummary),
    role: stringValue(raw['role'], 'viewer') as TaskListResponseDto['role'],
    generatedAt: stringValue(raw['generatedAt']),
  };
};

export const mapTaskDetailResponse = (value: unknown): TaskDetailResponseDto => {
  const raw = record(value);
  const summary = mapTaskSummary(raw['summary'] ?? raw['task']);
  return {
    task: mapTaskDetail(raw['task'], summary),
    summary,
    activeLeases: records(raw['activeLeases']).map(mapLease),
    children: records(raw['children']).map((child): ChildTaskSummaryDto => ({
      ...mapTaskSummary(child),
      ...(optionalString(child['dependencyReason'])
        ? { dependencyReason: optionalString(child['dependencyReason']) }
        : {}),
      ...(optionalString(child['externalMirrorStatus'])
        ? { externalMirrorStatus: optionalString(child['externalMirrorStatus']) }
        : {}),
    })),
    ...(mapValidation(raw['latestValidation']) ? { latestValidation: mapValidation(raw['latestValidation']) } : {}),
    ...(mapMergeRequest(raw['latestMergeRequest'])
      ? { latestMergeRequest: mapMergeRequest(raw['latestMergeRequest']) }
      : {}),
    diagnostics: mapDiagnostics(raw['diagnostics']),
  };
};

export const mapDiagnostics = (value: unknown): TaskDiagnosticsDto => {
  const raw = record(value);
  return {
    ...(raw['latestFailure'] !== undefined ? { latestFailure: raw['latestFailure'] } : {}),
    ...(Array.isArray(raw['failedRuns']) ? { failedRuns: raw['failedRuns'] } : {}),
    repeatedValidationFailures:
      typeof raw['repeatedValidationFailures'] === 'number' ? raw['repeatedValidationFailures'] : 0,
  };
};

export const mapCreateTaskResponse = (value: unknown): CreateTaskResponseDto => {
  const raw = record(value);
  return {
    task: mapTaskDetail(raw['task']),
    idempotent: raw['idempotent'] === true,
  };
};

export const mapCommandResponse = (value: unknown): CommandResponseDto => {
  const raw = record(value);
  return {
    task: mapTaskDetail(raw['task']),
  };
};

export const mapConversationResponse = (value: unknown): TaskConversationResponseDto => {
  const raw = record(value);
  return {
    comments: records(raw['comments']).map(mapComment),
    questions: records(raw['questions']).map(mapQuestion),
    answers: records(raw['answers']).map(mapAnswer),
  };
};

export const mapProposalListResponse = (value: unknown): ProposalListResponseDto => {
  const raw = record(value);
  return {
    proposals: records(raw['proposals']).map(mapProposalSummary),
    role: stringValue(raw['role'], 'viewer') as ProposalListResponseDto['role'],
    generatedAt: stringValue(raw['generatedAt']),
  };
};

export const mapProposalSummary = (value: unknown): ProposalSummaryDto => {
  const raw = record(value);
  const proposal = record(raw['proposal']);
  return {
    ...mapTaskSummary(raw),
    proposal: {
      supervisorStatus: stringValue(proposal['supervisorStatus']),
      ...(optionalString(proposal['approvalPolicy'])
        ? { approvalPolicy: optionalString(proposal['approvalPolicy']) }
        : {}),
      ...(optionalString(proposal['autonomyLevel'])
        ? { autonomyLevel: optionalString(proposal['autonomyLevel']) }
        : {}),
      ...(optionalString(proposal['proposedBy']) ? { proposedBy: optionalString(proposal['proposedBy']) } : {}),
      ...(optionalString(proposal['proposalReason'])
        ? { proposalReason: optionalString(proposal['proposalReason']) }
        : {}),
      ...(optionalString(proposal['policyDecision'])
        ? { policyDecision: optionalString(proposal['policyDecision']) }
        : {}),
      ...(optionalString(proposal['policyReason'])
        ? { policyReason: optionalString(proposal['policyReason']) }
        : {}),
      ...(Array.isArray(proposal['evidenceRefs'])
        ? { evidenceRefs: records(proposal['evidenceRefs']).map((entry) => ({
            kind: stringValue(entry['kind']),
            ref: stringValue(entry['ref']),
            ...(optionalString(entry['summary']) ? { summary: optionalString(entry['summary']) } : {}),
          })) }
        : {}),
      ...(Array.isArray(proposal['suggestedAcceptanceCriteria'])
        ? { suggestedAcceptanceCriteria: stringArray(proposal['suggestedAcceptanceCriteria']) }
        : {}),
      createdAt: stringValue(proposal['createdAt']),
    },
  };
};

export const mapWorker = (value: unknown): WorkerSnapshotDto => {
  const raw = record(value);
  return {
    workerId: stringValue(raw['workerId']),
    state: stringValue(raw['state']),
    ...(optionalString(raw['repositoryName'])
      ? { repositoryName: optionalString(raw['repositoryName']) }
      : {}),
    ...(optionalString(raw['currentTaskId'])
      ? { currentTaskId: optionalString(raw['currentTaskId']) }
      : {}),
    ...(optionalString(raw['currentIssueKey'] ?? raw['issueKey'])
      ? { currentIssueKey: optionalString(raw['currentIssueKey'] ?? raw['issueKey']) }
      : {}),
    ...(optionalString(raw['issueKey'] ?? raw['currentIssueKey'])
      ? { issueKey: optionalString(raw['issueKey'] ?? raw['currentIssueKey']) }
      : {}),
    ...(optionalString(raw['currentStage'] ?? raw['stage'])
      ? { currentStage: optionalString(raw['currentStage'] ?? raw['stage']) }
      : {}),
    ...(optionalString(raw['stage'] ?? raw['currentStage'])
      ? { stage: optionalString(raw['stage'] ?? raw['currentStage']) }
      : {}),
    ...(optionalString(raw['startedAt']) ? { startedAt: optionalString(raw['startedAt']) } : {}),
    ...(optionalString(raw['lastHeartbeatAt'] ?? raw['updatedAt'])
      ? { lastHeartbeatAt: optionalString(raw['lastHeartbeatAt'] ?? raw['updatedAt']) }
      : {}),
    ...(optionalString(raw['updatedAt'] ?? raw['lastHeartbeatAt'])
      ? { updatedAt: optionalString(raw['updatedAt'] ?? raw['lastHeartbeatAt']) }
      : {}),
    ...(optionalString(raw['lastErrorSummary'])
      ? { lastErrorSummary: optionalString(raw['lastErrorSummary']) }
      : {}),
    ...(typeof raw['activeLeaseAgeSeconds'] === 'number'
      ? { activeLeaseAgeSeconds: raw['activeLeaseAgeSeconds'] }
      : {}),
  };
};

export const mapQueueDepth = (value: unknown): QueueDepthDto => {
  const raw = record(value);
  return {
    repositoryName: stringValue(raw['repositoryName']),
    queue: stringValue(raw['queue']),
    status: stringValue(raw['status']),
    ...(optionalString(raw['priority']) ? { priority: optionalString(raw['priority']) } : {}),
    depth: typeof raw['depth'] === 'number' ? raw['depth'] : 0,
  };
};

export const mapOperationAgentRun = (value: unknown): OperationAgentRunSummaryDto | undefined => {
  if (!value) {
    return undefined;
  }
  const raw = record(value);
  return {
    ...(optionalString(raw['id']) ? { id: optionalString(raw['id']) } : {}),
    ...(optionalString(raw['workerId']) ? { workerId: optionalString(raw['workerId']) } : {}),
    ...(optionalString(raw['stage']) ? { stage: optionalString(raw['stage']) } : {}),
    ...(optionalString(raw['status']) ? { status: optionalString(raw['status']) } : {}),
    ...(typeof raw['exitCode'] === 'number' ? { exitCode: raw['exitCode'] } : {}),
    ...(typeof raw['timedOut'] === 'boolean' ? { timedOut: raw['timedOut'] } : {}),
    ...(optionalString(raw['finalMessage'])
      ? { finalMessage: optionalString(raw['finalMessage']) }
      : {}),
    ...(optionalString(raw['diagnostic']) ? { diagnostic: optionalString(raw['diagnostic']) } : {}),
    ...(optionalString(raw['startedAt']) ? { startedAt: optionalString(raw['startedAt']) } : {}),
    ...(optionalString(raw['completedAt'])
      ? { completedAt: optionalString(raw['completedAt']) }
      : {}),
  };
};

export const mapOperationValidation = (
  value: unknown,
): OperationValidationSummaryDto | undefined => {
  if (!value) {
    return undefined;
  }
  const raw = record(value);
  return {
    ...(optionalString(raw['id']) ? { id: optionalString(raw['id']) } : {}),
    ...(optionalString(raw['workerId']) ? { workerId: optionalString(raw['workerId']) } : {}),
    status: stringValue(raw['status']),
    ...(typeof raw['changed'] === 'boolean' ? { changed: raw['changed'] } : {}),
    ...(typeof raw['testsPassed'] === 'boolean' ? { testsPassed: raw['testsPassed'] } : {}),
    ...(typeof raw['lintPassed'] === 'boolean' ? { lintPassed: raw['lintPassed'] } : {}),
    ...(optionalString(raw['summary']) ? { summary: optionalString(raw['summary']) } : {}),
    ...(optionalString(raw['diagnostic']) ? { diagnostic: optionalString(raw['diagnostic']) } : {}),
    createdAt: stringValue(raw['createdAt']),
  };
};

export const mapOperationQuestion = (
  value: unknown,
): OperationQuestionSummaryDto | undefined => {
  if (!value) {
    return undefined;
  }
  const raw = record(value);
  return {
    id: stringValue(raw['id']),
    ...(optionalString(raw['summary']) ? { summary: optionalString(raw['summary']) } : {}),
    ...(optionalString(raw['blockingReason'])
      ? { blockingReason: optionalString(raw['blockingReason']) }
      : {}),
    ...(optionalString(raw['question']) ? { question: optionalString(raw['question']) } : {}),
    createdAt: stringValue(raw['createdAt']),
  };
};

export const mapOperationEvent = (value: unknown): OperationEventSummaryDto => {
  const raw = record(value);
  return {
    ...(optionalString(raw['id']) ? { id: optionalString(raw['id']) } : {}),
    kind: stringValue(raw['kind']),
    ...(optionalString(raw['source']) ? { source: optionalString(raw['source']) } : {}),
    ...(optionalString(raw['message']) ? { message: optionalString(raw['message']) } : {}),
    createdAt: stringValue(raw['createdAt']),
  };
};

export const mapOperationTaskDiagnostic = (value: unknown): OperationTaskDiagnosticDto => {
  const raw = record(value);
  return {
    taskId: stringValue(raw['taskId']),
    ...(mapOperationAgentRun(raw['latestFailedAgentRun'])
      ? { latestFailedAgentRun: mapOperationAgentRun(raw['latestFailedAgentRun']) }
      : {}),
    ...(mapOperationValidation(raw['latestValidation'])
      ? { latestValidation: mapOperationValidation(raw['latestValidation']) }
      : {}),
    ...(mapOperationQuestion(raw['latestQuestion'])
      ? { latestQuestion: mapOperationQuestion(raw['latestQuestion']) }
      : {}),
    failedAgentRuns: typeof raw['failedAgentRuns'] === 'number' ? raw['failedAgentRuns'] : 0,
    repeatedValidationFailures:
      typeof raw['repeatedValidationFailures'] === 'number' ? raw['repeatedValidationFailures'] : 0,
    recentEvents: records(raw['recentEvents']).map(mapOperationEvent),
    updatedAt: stringValue(raw['updatedAt']),
  };
};

export const mapOperationsSnapshot = (value: unknown): OperationsSnapshotDto => {
  const raw = record(value);
  return {
    workers: records(raw['workers']).map(mapWorker),
    leases: records(raw['leases']).map(mapLease),
    repositories: stringArray(raw['repositories']),
    queueDepth: records(raw['queueDepth']).map(mapQueueDepth),
    failedTasks: records(raw['failedTasks']).map(mapTaskSummary),
    repeatedFailures: records(raw['repeatedFailures']).map(mapTaskSummary),
    waitingForHuman: records(raw['waitingForHuman']).map(mapTaskSummary),
    ...(Array.isArray(raw['taskDiagnostics'])
      ? { taskDiagnostics: records(raw['taskDiagnostics']).map(mapOperationTaskDiagnostic) }
      : {}),
    generatedAt: stringValue(raw['generatedAt']),
  };
};
