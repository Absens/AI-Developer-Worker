import { describe, expect, it } from "vitest";

import {
  resolveTelegramExecutionRepositoryProfile,
  type TelegramExecutionRepositoryProfile,
} from "../src/domain/telegramAssistant/index.js";
import type { RepositoryProfile } from "../src/models/types.js";

const repositoryFixture = (
  overrides: Partial<RepositoryProfile> = {},
): RepositoryProfile => ({
  name: overrides.name ?? "developer",
  repoPath: overrides.repoPath ?? "C:\\repo\\developer",
  gitlabProjectId: overrides.gitlabProjectId ?? "developer/project",
  gitRemoteName: overrides.gitRemoteName ?? "origin",
  baseBranch: overrides.baseBranch ?? "main",
  queues: overrides.queues ?? ["DEV"],
  tags: overrides.tags ?? [],
  testCommand: overrides.testCommand ?? "npm test",
  lintCommand: overrides.lintCommand ?? "npm run typecheck",
  ...overrides,
});

const executionProfile = (
  overrides: Partial<TelegramExecutionRepositoryProfile> = {},
): TelegramExecutionRepositoryProfile => ({
  repositoryName: overrides.repositoryName ?? "developer",
  repoPathKey: overrides.repoPathKey ?? "developer",
  baseBranch: overrides.baseBranch ?? "main",
  queue: overrides.queue ?? "DEV",
  tags: overrides.tags ?? [],
});

describe("resolveTelegramExecutionRepositoryProfile", () => {
  it("selects the only executable repository profile", () => {
    const resolution = resolveTelegramExecutionRepositoryProfile({
      repositories: [
        repositoryFixture({ name: "docs", queues: [] }),
        repositoryFixture({
          name: "developer",
          queues: ["DEV"],
          tags: ["telegram"],
        }),
      ],
      text: "создай задачу",
    });

    expect(resolution).toEqual({
      status: "selected",
      reason: "single_profile",
      profile: executionProfile({ tags: ["telegram"] }),
    });
  });

  it("selects by repository name, queue, or tag mention", () => {
    const repositories = [
      repositoryFixture({
        name: "frontend",
        baseBranch: "main",
        queues: ["FRONTEND"],
        tags: ["ui"],
      }),
      repositoryFixture({
        name: "backend",
        baseBranch: "develop",
        queues: ["BACKEND"],
        tags: ["api"],
      }),
    ];

    expect(resolveTelegramExecutionRepositoryProfile({
      repositories,
      text: "заведи задачу для backend",
    })).toEqual({
      status: "selected",
      reason: "text_match",
      profile: executionProfile({
        repositoryName: "backend",
        repoPathKey: "backend",
        baseBranch: "develop",
        queue: "BACKEND",
        tags: ["api"],
      }),
    });
    expect(resolveTelegramExecutionRepositoryProfile({
      repositories,
      text: "нужно починить очередь FRONTEND",
    })).toEqual({
      status: "selected",
      reason: "text_match",
      profile: executionProfile({
        repositoryName: "frontend",
        repoPathKey: "frontend",
        queue: "FRONTEND",
        tags: ["ui"],
      }),
    });
    expect(resolveTelegramExecutionRepositoryProfile({
      repositories,
      text: "создай задачу api",
    })).toEqual({
      status: "selected",
      reason: "text_match",
      profile: executionProfile({
        repositoryName: "backend",
        repoPathKey: "backend",
        baseBranch: "develop",
        queue: "BACKEND",
        tags: ["api"],
      }),
    });
  });

  it("selects the default repository before considering text matches", () => {
    const repositories = [
      repositoryFixture({
        name: "frontend",
        queues: ["FRONTEND"],
      }),
      repositoryFixture({
        name: "backend",
        baseBranch: "develop",
        queues: ["BACKEND"],
      }),
    ];

    expect(resolveTelegramExecutionRepositoryProfile({
      repositories,
      defaultRepository: "frontend",
      text: "создай задачу для backend",
    })).toEqual({
      status: "selected",
      reason: "default_repository",
      profile: executionProfile({
        repositoryName: "frontend",
        repoPathKey: "frontend",
        queue: "FRONTEND",
      }),
    });
  });

  it("does not match non-primary repository queues", () => {
    const repositories = [
      repositoryFixture({
        name: "frontend",
        queues: ["FRONTEND", "LEGACY"],
      }),
      repositoryFixture({
        name: "backend",
        baseBranch: "develop",
        queues: ["BACKEND"],
      }),
    ];

    expect(resolveTelegramExecutionRepositoryProfile({
      repositories,
      text: "создай задачу для LEGACY",
    })).toEqual({
      status: "needs_selection",
      options: [
        executionProfile({
          repositoryName: "frontend",
          repoPathKey: "frontend",
          queue: "FRONTEND",
        }),
        executionProfile({
          repositoryName: "backend",
          repoPathKey: "backend",
          baseBranch: "develop",
          queue: "BACKEND",
        }),
      ],
    });
  });

  it("returns selection options when multiple profiles are possible", () => {
    const repositories = [
      repositoryFixture({
        name: "frontend",
        queues: ["FRONTEND"],
        tags: ["app"],
      }),
      repositoryFixture({
        name: "backend",
        baseBranch: "develop",
        queues: ["BACKEND"],
        tags: ["app"],
      }),
    ];

    expect(resolveTelegramExecutionRepositoryProfile({
      repositories,
      text: "создай задачу для app",
    })).toEqual({
      status: "needs_selection",
      options: [
        executionProfile({
          repositoryName: "frontend",
          repoPathKey: "frontend",
          queue: "FRONTEND",
          tags: ["app"],
        }),
        executionProfile({
          repositoryName: "backend",
          repoPathKey: "backend",
          baseBranch: "develop",
          queue: "BACKEND",
          tags: ["app"],
        }),
      ],
    });
    expect(resolveTelegramExecutionRepositoryProfile({
      repositories,
      text: "создай задачу",
    })).toEqual({
      status: "needs_selection",
      options: [
        executionProfile({
          repositoryName: "frontend",
          repoPathKey: "frontend",
          queue: "FRONTEND",
          tags: ["app"],
        }),
        executionProfile({
          repositoryName: "backend",
          repoPathKey: "backend",
          baseBranch: "develop",
          queue: "BACKEND",
          tags: ["app"],
        }),
      ],
    });
  });

  it("returns unavailable when no repository can execute tasks", () => {
    expect(resolveTelegramExecutionRepositoryProfile({
      repositories: [],
      text: "создай задачу",
    })).toEqual({
      status: "unavailable",
      reason: "no_profiles",
    });
    expect(resolveTelegramExecutionRepositoryProfile({
      repositories: [
        repositoryFixture({ name: "developer", queues: [] }),
      ],
      text: "создай задачу",
    })).toEqual({
      status: "unavailable",
      reason: "profile_missing_queue",
    });
    expect(resolveTelegramExecutionRepositoryProfile({
      repositories: [
        repositoryFixture({ name: "developer", queues: ["  "] }),
      ],
      text: "создай задачу",
    })).toEqual({
      status: "unavailable",
      reason: "profile_missing_queue",
    });
  });
});
