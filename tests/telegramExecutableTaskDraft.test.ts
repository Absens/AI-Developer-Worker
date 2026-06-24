import { describe, expect, it } from "vitest";

import {
  buildTelegramExecutableTaskDraft,
  applyExecutableDraftAnswer,
  classifyTelegramTaskRisk,
  nextExecutableDraftQuestion,
  resolveTelegramExecutionRepositoryProfile,
  type TelegramExecutableTaskDraft,
  type TelegramExecutableTaskDraftSession,
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

  it("does not match short tags inside unrelated longer words", () => {
    const repositories = [
      repositoryFixture({
        name: "frontend",
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
      text: "создай задачу для building",
    })).toEqual({
      status: "needs_selection",
      options: [
        executionProfile({
          repositoryName: "frontend",
          repoPathKey: "frontend",
          queue: "FRONTEND",
          tags: ["ui"],
        }),
        executionProfile({
          repositoryName: "backend",
          repoPathKey: "backend",
          baseBranch: "develop",
          queue: "BACKEND",
          tags: ["api"],
        }),
      ],
    });
    expect(resolveTelegramExecutionRepositoryProfile({
      repositories,
      text: "создай задачу для ui",
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

describe("classifyTelegramTaskRisk", () => {
  it("classifies destructive infrastructure changes as high risk with owner approval", () => {
    expect(classifyTelegramTaskRisk(
      "нужно добавить миграцию, удалить старые данные и задеплоить в prod",
    )).toEqual({
      riskLevel: "high",
      reasons: ["data_destructive_or_migration", "infrastructure_or_deploy"],
      requiresOwnerApproval: true,
    });
  });

  it("classifies documentation and test work as low risk", () => {
    expect(classifyTelegramTaskRisk(
      "поправь README, опечатки и добавь coverage для тестов",
    )).toEqual({
      riskLevel: "low",
      reasons: ["documentation_or_tests"],
      requiresOwnerApproval: false,
    });
  });

  it("classifies isolated feature or bugfix work as medium risk", () => {
    expect(classifyTelegramTaskRisk(
      "добавь фильтр по статусу в списке задач",
    )).toEqual({
      riskLevel: "medium",
      reasons: ["isolated_feature_or_bugfix"],
      requiresOwnerApproval: false,
    });
  });

  it("uses token boundaries for Russian risk keywords", () => {
    expect(classifyTelegramTaskRisk("выкатить на прод")).toEqual({
      riskLevel: "high",
      reasons: ["infrastructure_or_deploy"],
      requiresOwnerApproval: true,
    });

    expect(classifyTelegramTaskRisk("уточнить контекст задачи")).toEqual({
      riskLevel: "medium",
      reasons: ["isolated_feature_or_bugfix"],
      requiresOwnerApproval: false,
    });
  });
});

describe("buildTelegramExecutableTaskDraft", () => {
  it("builds an executable draft from text and a selected repository profile", () => {
    const draft = buildTelegramExecutableTaskDraft({
      text: "создай задачу добавить фильтр по статусу в списке задач",
      selectedProfile: executionProfile({
        repositoryName: "frontend",
        repoPathKey: "frontend",
        baseBranch: "develop",
        queue: "FRONTEND",
        tags: ["ui", "telegram"],
      }),
    });

    expect(draft).toEqual({
      title: "добавить фильтр по статусу в списке задач",
      description: "создай задачу добавить фильтр по статусу в списке задач",
      acceptanceCriteria: ["Поведение реализовано и покрыто существующими проверками."],
      repositoryName: "frontend",
      repoPathKey: "frontend",
      baseBranch: "develop",
      queue: "FRONTEND",
      tags: ["telegram", "ui", "risk_medium"],
      risk: {
        riskLevel: "medium",
        reasons: ["isolated_feature_or_bugfix"],
        requiresOwnerApproval: false,
      },
      executionMode: "auto_ready",
    });
  });

  it("asks for repository profile before other missing draft details", () => {
    const draft = buildTelegramExecutableTaskDraft({
      text: "сделай",
    });

    expect(nextExecutableDraftQuestion(draft)).toEqual({
      field: "repositoryProfile",
      text: "В каком репозитории выполнить задачу?",
    });
  });

  it("asks for description when selected profile text only contains a create-task command", () => {
    const draft = buildTelegramExecutableTaskDraft({
      text: "создай задачу",
      selectedProfile: executionProfile(),
    });

    expect(draft.executionMode).toBe("triage_only");
    expect(nextExecutableDraftQuestion(draft)).toEqual({
      field: "description",
      text: "Опиши задачу чуть подробнее: что нужно изменить и где это проверить?",
    });
  });

  it("checks description sufficiency from description even when title is stale", () => {
    const draft: TelegramExecutableTaskDraft = {
      title: "добавить фильтр по статусу",
      description: "создай задачу",
      acceptanceCriteria: ["Поведение реализовано."],
      repositoryName: "developer",
      repoPathKey: "developer",
      baseBranch: "main",
      queue: "DEV",
      tags: ["telegram", "risk_medium"],
      risk: {
        riskLevel: "medium",
        reasons: ["isolated_feature_or_bugfix"],
        requiresOwnerApproval: false,
      },
      executionMode: "auto_ready",
    };

    expect(nextExecutableDraftQuestion(draft)).toEqual({
      field: "description",
      text: "Опиши задачу чуть подробнее: что нужно изменить и где это проверить?",
    });
  });

  it("uses owner approval mode for high-risk and forced approval drafts", () => {
    expect(buildTelegramExecutableTaskDraft({
      text: "надо сделать deploy в prod и обновить docker конфиг",
      selectedProfile: executionProfile(),
    }).executionMode).toBe("owner_approval");

    expect(buildTelegramExecutableTaskDraft({
      text: "добавь фильтр по статусу",
      selectedProfile: executionProfile(),
      forceOwnerApproval: true,
    }).executionMode).toBe("owner_approval");
  });

  it("applies repository clarification answers and recomputes readiness", () => {
    const draft = buildTelegramExecutableTaskDraft({
      text: "создай задачу поправить текст",
    });

    const updated = applyExecutableDraftAnswer(
      draft,
      {
        field: "repositoryProfile",
        text: "В каком репозитории выполнить задачу?",
      },
      "frontend",
      [
        executionProfile({
          repositoryName: "frontend",
          repoPathKey: "frontend",
          queue: "FRONTEND",
          tags: ["ui", "telegram"],
        }),
        executionProfile({
          repositoryName: "backend",
          repoPathKey: "backend",
          queue: "BACKEND",
          tags: ["api"],
        }),
      ],
    );

    expect(updated).toMatchObject({
      repositoryName: "frontend",
      repoPathKey: "frontend",
      baseBranch: "main",
      queue: "FRONTEND",
      executionMode: "auto_ready",
      tags: ["telegram", "risk_low", "ui"],
    });
    expect(nextExecutableDraftQuestion(updated)).toBeUndefined();
    expect(applyExecutableDraftAnswer(
      draft,
      {
        field: "repositoryProfile",
        text: "В каком репозитории выполнить задачу?",
      },
      "unknown",
      [executionProfile({ repositoryName: "frontend", queue: "FRONTEND" })],
    )).toEqual(draft);
  });

  it("uses numeric owner identifiers in executable draft sessions", () => {
    const session: TelegramExecutableTaskDraftSession = {
      id: "draft-1",
      conversationKey: "private:100",
      source: "private",
      initiatorUserId: 100,
      ownerUserId: 200,
      ownerChatId: 300,
      chatId: 100,
      originalText: "создай задачу добавить фильтр",
      draft: buildTelegramExecutableTaskDraft({
        text: "создай задачу добавить фильтр",
        selectedProfile: executionProfile(),
      }),
      status: "collecting",
      clarificationHistory: [],
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
      expiresAt: "2026-06-25T00:00:00.000Z",
    };

    expect(session.ownerUserId).toBe(200);
    expect(session.ownerChatId).toBe(300);
  });
});
