import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  findActiveLease,
  formatLeaseComment,
} from "../integrations/tracker/commentProtocol.js";
import type {
  AcquireRepositoryLeaseInput,
  AcquireTaskLeaseInput,
  LeaseKind,
  LockBackend,
  TaskLease,
  TrackerClient,
} from "../models/types.js";
import { TemporaryIntegrationError } from "../utils/errors.js";

const DEFAULT_RENEWAL_TIMEOUT_MS = 15 * 60 * 1000;

export const normalizeRepoPathForLease = (repoPath: string): string =>
  resolve(repoPath).replace(/\\/g, "/").toLowerCase();

const leaseKeyFor = (
  kind: LeaseKind,
  issueKey: string,
  repoPath: string,
  override?: string,
): string => {
  if (override) {
    return override;
  }

  if (kind === "repository") {
    return `repo:${normalizeRepoPathForLease(repoPath)}`;
  }

  return `task:${issueKey}`;
};

const buildLease = (
  kind: LeaseKind,
  leaseKey: string,
  input: AcquireTaskLeaseInput,
): TaskLease => {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  return {
    kind,
    leaseKey,
    issueKey: input.issueKey,
    workerId: input.workerId,
    repositoryName: input.repositoryName,
    repoPath: input.repoPath,
    acquiredAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
    token: `lease-${randomUUID()}`,
  };
};

export class TrackerCommentLockBackend implements LockBackend {
  constructor(
    private readonly tracker: TrackerClient,
    private readonly ttlMs: number,
  ) {}

  async acquireTaskLease(input: AcquireTaskLeaseInput): Promise<TaskLease | null> {
    return this.acquireLease("task", input, leaseKeyFor("task", input.issueKey, input.repoPath));
  }

  async acquireRepositoryLease(input: AcquireRepositoryLeaseInput): Promise<TaskLease | null> {
    return this.acquireLease(
      "repository",
      input,
      leaseKeyFor("repository", input.issueKey, input.repoPath, input.leaseKey),
    );
  }

  async renewTaskLease(lease: TaskLease): Promise<TaskLease> {
    const activeLease = await this.getActiveLease(lease.issueKey, {
      kind: lease.kind,
      leaseKey: lease.leaseKey,
    });
    if (!activeLease || activeLease.token !== lease.token) {
      throw new TemporaryIntegrationError(
        `Unable to renew ${lease.kind} lease for ${lease.issueKey}; active lease token changed or expired.`,
      );
    }

    const now = new Date();
    const renewed: TaskLease = {
      ...lease,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    await this.tracker.addComment(lease.issueKey, formatLeaseComment(renewed));
    return renewed;
  }

  async releaseTaskLease(lease: TaskLease): Promise<void> {
    const now = new Date().toISOString();
    await this.tracker.addComment(
      lease.issueKey,
      formatLeaseComment({
        ...lease,
        heartbeatAt: now,
        expiresAt: now,
        releasedAt: now,
      }),
    );
  }

  async getActiveLease(
    issueKey: string,
    options: {
      kind?: LeaseKind;
      leaseKey?: string;
      now?: Date;
    } = {},
  ): Promise<TaskLease | null> {
    const comments = await this.tracker.getComments(issueKey);
    return findActiveLease(comments, options) ?? null;
  }

  private async acquireLease(
    kind: LeaseKind,
    input: AcquireTaskLeaseInput,
    leaseKey: string,
  ): Promise<TaskLease | null> {
    const activeLease = await this.getActiveLease(input.issueKey, {
      kind,
      leaseKey,
      now: input.now,
    });
    if (activeLease) {
      if (activeLease.workerId !== input.workerId) {
        return null;
      }

      return this.renewTaskLease(activeLease);
    }

    const lease = buildLease(kind, leaseKey, input);
    await this.tracker.addComment(input.issueKey, formatLeaseComment(lease));
    const verified = await this.getActiveLease(input.issueKey, {
      kind,
      leaseKey,
      now: input.now,
    });

    return verified?.token === lease.token ? lease : null;
  }
}

export class NoopLockBackend implements LockBackend {
  async acquireTaskLease(input: AcquireTaskLeaseInput): Promise<TaskLease> {
    return buildLease("task", leaseKeyFor("task", input.issueKey, input.repoPath), input);
  }

  async acquireRepositoryLease(input: AcquireRepositoryLeaseInput): Promise<TaskLease> {
    return buildLease(
      "repository",
      leaseKeyFor("repository", input.issueKey, input.repoPath, input.leaseKey),
      input,
    );
  }

  async renewTaskLease(lease: TaskLease): Promise<TaskLease> {
    const now = new Date();
    return {
      ...lease,
      heartbeatAt: now.toISOString(),
    };
  }

  async releaseTaskLease(_lease: TaskLease): Promise<void> {
    return;
  }

  async getActiveLease(
    _issueKey: string,
    _options: {
      kind?: LeaseKind;
      leaseKey?: string;
      now?: Date;
    } = {},
  ): Promise<TaskLease | null> {
    return null;
  }
}

export const withLeaseHeartbeat = async <T>(
  backend: LockBackend,
  leases: TaskLease[],
  heartbeatMs: number,
  callback: () => Promise<T>,
): Promise<T> => {
  if (leases.length === 0 || heartbeatMs <= 0) {
    return callback();
  }

  let activeLeases = leases;
  let renewalError: unknown;
  let renewing = false;
  const renew = async (): Promise<void> => {
    if (renewing || renewalError) {
      return;
    }

    renewing = true;
    try {
      activeLeases = await Promise.all(
        activeLeases.map((lease) => backend.renewTaskLease(lease)),
      );
    } catch (error) {
      renewalError = error;
    } finally {
      renewing = false;
    }
  };

  const interval = setInterval(() => {
    void renew();
  }, heartbeatMs);

  try {
    const result = await callback();
    if (renewalError) {
      throw renewalError;
    }
    return result;
  } finally {
    clearInterval(interval);
    await Promise.allSettled(activeLeases.map((lease) => backend.releaseTaskLease(lease)));
  }
};

export const leaseTtlFromConfig = (ttlMs: number | undefined): number =>
  ttlMs && ttlMs > 0 ? ttlMs : DEFAULT_RENEWAL_TIMEOUT_MS;
