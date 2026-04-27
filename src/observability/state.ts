export type WorkerRuntimeState =
  | "starting"
  | "idle"
  | "polling"
  | "processing"
  | "waiting"
  | "error"
  | "shutting_down";

export interface WorkerStateSnapshot {
  workerId: string;
  state: WorkerRuntimeState;
  repositoryName?: string;
  currentIssueKey?: string;
  currentStage?: string;
  startedAt: string;
  lastHeartbeatAt: string;
  lastErrorSummary?: string;
  activeLeaseAgeSeconds?: number;
}

export interface RepositoryQueueSnapshot {
  repositoryName: string;
  queue: string;
  depth: number;
  updatedAt: string;
}

export interface WorkerStateRegistry {
  update(input: {
    workerId: string;
    state: WorkerRuntimeState;
    repositoryName?: string;
    issueKey?: string;
    stage?: string;
    error?: string;
  }): void;
  heartbeat(workerId: string): void;
  setQueueDepth(repositoryName: string, queue: string, depth: number): void;
  listWorkers(): WorkerStateSnapshot[];
  listQueues(): RepositoryQueueSnapshot[];
}

const nowIso = (): string => new Date().toISOString();

export class InMemoryWorkerStateRegistry implements WorkerStateRegistry {
  private readonly workers = new Map<string, WorkerStateSnapshot>();
  private readonly queues = new Map<string, RepositoryQueueSnapshot>();

  update(input: {
    workerId: string;
    state: WorkerRuntimeState;
    repositoryName?: string;
    issueKey?: string;
    stage?: string;
    error?: string;
  }): void {
    const current = this.workers.get(input.workerId);
    const timestamp = nowIso();
    this.workers.set(input.workerId, {
      workerId: input.workerId,
      state: input.state,
      ...(input.repositoryName ? { repositoryName: input.repositoryName } : {}),
      ...(input.issueKey ? { currentIssueKey: input.issueKey } : {}),
      ...(input.stage ? { currentStage: input.stage } : {}),
      startedAt: current?.startedAt ?? timestamp,
      lastHeartbeatAt: timestamp,
      ...(input.error ? { lastErrorSummary: input.error } : current?.lastErrorSummary ? { lastErrorSummary: current.lastErrorSummary } : {}),
    });
  }

  heartbeat(workerId: string): void {
    const current = this.workers.get(workerId);
    if (!current) {
      return;
    }

    this.workers.set(workerId, {
      ...current,
      lastHeartbeatAt: nowIso(),
    });
  }

  setQueueDepth(repositoryName: string, queue: string, depth: number): void {
    this.queues.set(`${repositoryName}\u0000${queue}`, {
      repositoryName,
      queue,
      depth,
      updatedAt: nowIso(),
    });
  }

  listWorkers(): WorkerStateSnapshot[] {
    return [...this.workers.values()].sort((left, right) =>
      left.workerId.localeCompare(right.workerId),
    );
  }

  listQueues(): RepositoryQueueSnapshot[] {
    return [...this.queues.values()].sort((left, right) =>
      `${left.repositoryName}:${left.queue}`.localeCompare(
        `${right.repositoryName}:${right.queue}`,
      ),
    );
  }
}

export class NoopWorkerStateRegistry implements WorkerStateRegistry {
  update(): void {}
  heartbeat(): void {}
  setQueueDepth(): void {}
  listWorkers(): WorkerStateSnapshot[] {
    return [];
  }
  listQueues(): RepositoryQueueSnapshot[] {
    return [];
  }
}
