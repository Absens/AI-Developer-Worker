export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} was not found.`);
  }
}

export class DuplicateExternalRefError extends Error {
  constructor(
    readonly provider: string,
    readonly externalKey: string,
  ) {
    super(`External ref ${provider}:${externalKey} is already attached to a task.`);
  }
}

export class TaskReadinessError extends Error {
  constructor(readonly missingFields: string[]) {
    super(`Task is missing required execution fields: ${missingFields.join(", ")}.`);
  }
}

export class LeaseNotFoundError extends Error {
  constructor(readonly leaseId: string) {
    super(`Lease ${leaseId} was not found.`);
  }
}

export class LeaseOwnershipError extends Error {
  constructor(readonly leaseId: string) {
    super(`Lease ${leaseId} does not belong to the supplied worker and token.`);
  }
}

export class LeaseExpiredError extends Error {
  constructor(readonly leaseId: string) {
    super(`Lease ${leaseId} has expired.`);
  }
}
