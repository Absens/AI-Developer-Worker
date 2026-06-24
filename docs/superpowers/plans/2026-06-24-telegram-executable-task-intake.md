# Telegram Executable Task Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let trusted Telegram users and owner-approved Business/TWIN proposals create execution-ready internal tasks, queue them for the existing worker, and receive Telegram lifecycle/resume notifications.

**Architecture:** Telegram Assistant becomes an intake/control layer over the existing internal tracker queue. New small domain modules build executable task drafts, resolve repository profiles, classify risk, and apply execution policy; `TelegramAssistantService` orchestrates sessions and approvals while `TaskTrackerClient` remains the write boundary and `InternalWorkerOrchestrator` remains the executor.

**Tech Stack:** Node.js 22, TypeScript ES modules, Vitest, PostgreSQL migrations through the existing internal tracker migration runner, Telegram Bot API adapter already in `src/integrations/telegram`.

---

## File Structure

- Create `src/domain/telegramAssistant/repositoryProfileResolver.ts`
  Resolves `RepositoryProfile[]` to execution metadata: `repositoryName`, `repoPathKey`, `baseBranch`, `queue`, `tags`.
- Create `src/domain/telegramAssistant/riskClassifier.ts`
  Deterministic low/medium/high risk classifier for Telegram task drafts.
- Create `src/domain/telegramAssistant/executableTaskDraft.ts`
  Draft-session model helpers, clarification field detection, approval payload builders, task input conversion.
- Modify `src/domain/telegramAssistant/types.ts`
  Add executable draft session, risk, execution decision, active task question prompt types.
- Modify `src/domain/telegramAssistant/taskDraftBuilder.ts`
  Keep `buildHeuristicTaskDraft` compatibility and add executable draft seed support.
- Modify `src/domain/telegramAssistant/store.ts`
  Add in-memory draft session and active task question prompt persistence.
- Modify `src/domain/telegramAssistant/postgresStore.ts`
  Add PostgreSQL mapping and methods for executable draft sessions and active task question prompts.
- Create `src/integrations/internalTracker/migrations/0015_telegram_executable_task_intake.sql`
  Persist draft sessions and active Telegram task questions.
- Modify `src/domain/telegramAssistant/service.ts`
  Replace one-shot create-task draft flow with executable draft session flow, enforce runtime flags, create ready tasks, support owner approvals and active question answers.
- Modify `src/domain/telegramAssistant/notificationRouter.ts`
  Render lifecycle-specific Telegram messages and register active task question prompts.
- Modify `src/domain/telegramAssistant/index.ts`
  Export new modules/types.
- Modify `tests/telegramAssistant.test.ts`
  Private trusted executable intake, clarification, ambiguity, flags, idempotency.
- Modify `tests/telegramProfileAutomation.test.ts`
  Owner approval for business/high-risk and explicit TWIN proposal routing.
- Modify `tests/telegramNotifications.test.ts`
  Lifecycle rendering and active task question prompt behavior.
- Modify `tests/telegramStore.test.ts`
  In-memory draft session and active question prompt persistence.
- Modify `tests/telegramPostgresStore.test.ts`
  PostgreSQL draft session and active question prompt mapping.
- Modify `tests/taskTrackerQueue.test.ts`
  Regression that Telegram-created ready tasks with execution fields are claimable.
- Modify `docs/TELEGRAM_TASK_INTAKE.md` if present, otherwise `README.md`
  Update current-state wording after implementation.

## Implementation Rules

- Do not add a Telegram-native executor. Execution must continue through `TaskTrackerClient.markReady()` and `InternalWorkerOrchestrator.claimTask()`.
- Use `repoPathKey = repository.name` for Telegram-created tasks unless a future config field adds an explicit repo path key. Current claim profiles match by `name/queues/tags`, while claim eligibility still requires task `repoPathKey` to be non-empty.
- `TELEGRAM_TASK_CREATION_ENABLED=false` must stop task creation before draft sessions or pending actions are created.
- `TELEGRAM_CONFIRM_WRITE_ACTIONS=true` must require a confirmation/approval pending action before `createTask`, `markReady`, or `recordHumanAnswer`.
- Prefer adding small domain helpers over adding more parsing logic directly inside `service.ts`.

---

### Task 1: Add Repository Profile Resolver

**Files:**
- Create: `src/domain/telegramAssistant/repositoryProfileResolver.ts`
- Modify: `src/domain/telegramAssistant/index.ts`
- Test: `tests/telegramExecutableTaskDraft.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Add `tests/telegramExecutableTaskDraft.test.ts` with these tests:

```ts
import { describe, expect, it } from "vitest";

import type { RepositoryProfile } from "../src/models/types.js";
import { resolveTelegramExecutionRepositoryProfile } from "../src/domain/telegramAssistant/index.js";

const profile = (overrides: Partial<RepositoryProfile> = {}): RepositoryProfile => ({
  name: overrides.name ?? "developer",
  repoPath: overrides.repoPath ?? "/workspace/developer",
  gitlabProjectId: overrides.gitlabProjectId ?? "1",
  gitRemoteName: overrides.gitRemoteName ?? "origin",
  baseBranch: overrides.baseBranch ?? "main",
  queues: overrides.queues ?? ["DEV"],
  tags: overrides.tags ?? ["ai_dev"],
  testCommand: overrides.testCommand ?? "npm test",
  lintCommand: overrides.lintCommand ?? "npm run typecheck",
  ...overrides,
});

describe("resolveTelegramExecutionRepositoryProfile", () => {
  it("selects the only executable repository profile", () => {
    expect(resolveTelegramExecutionRepositoryProfile({
      text: "создай задачу починить регистрацию",
      repositories: [profile()],
    })).toEqual({
      status: "selected",
      profile: {
        repositoryName: "developer",
        repoPathKey: "developer",
        baseBranch: "main",
        queue: "DEV",
        tags: ["ai_dev"],
      },
      reason: "single_profile",
    });
  });

  it("selects by repository name, queue or tag mention", () => {
    const result = resolveTelegramExecutionRepositoryProfile({
      text: "frontend: добавь проверку для очереди FRONTEND",
      repositories: [
        profile({ name: "backend", queues: ["BACKEND"], tags: ["api"] }),
        profile({ name: "frontend", queues: ["FRONTEND"], tags: ["ui"] }),
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      status: "selected",
      profile: expect.objectContaining({
        repositoryName: "frontend",
        repoPathKey: "frontend",
        queue: "FRONTEND",
      }),
      reason: "text_match",
    }));
  });

  it("returns selection options when multiple profiles are possible", () => {
    expect(resolveTelegramExecutionRepositoryProfile({
      text: "создай задачу поправить текст",
      repositories: [
        profile({ name: "frontend", queues: ["FRONTEND"] }),
        profile({ name: "backend", queues: ["BACKEND"] }),
      ],
    })).toEqual({
      status: "needs_selection",
      options: [
        expect.objectContaining({ repositoryName: "frontend", queue: "FRONTEND" }),
        expect.objectContaining({ repositoryName: "backend", queue: "BACKEND" }),
      ],
    });
  });

  it("returns unavailable when no repository can execute tasks", () => {
    expect(resolveTelegramExecutionRepositoryProfile({
      text: "создай задачу",
      repositories: [],
    })).toEqual({
      status: "unavailable",
      reason: "no_profiles",
    });
  });
});
```

- [ ] **Step 2: Run resolver test and verify it fails**

Run:

```bash
npx vitest run tests/telegramExecutableTaskDraft.test.ts
```

Expected: fail because `resolveTelegramExecutionRepositoryProfile` is not exported.

- [ ] **Step 3: Implement resolver**

Create `src/domain/telegramAssistant/repositoryProfileResolver.ts`:

```ts
import type { RepositoryProfile } from "../../models/types.js";

export interface TelegramExecutionRepositoryProfile {
  repositoryName: string;
  repoPathKey: string;
  baseBranch: string;
  queue: string;
  tags: string[];
}

export type TelegramRepositoryProfileResolution =
  | {
      status: "selected";
      profile: TelegramExecutionRepositoryProfile;
      reason: "single_profile" | "default_repository" | "text_match";
    }
  | {
      status: "needs_selection";
      options: TelegramExecutionRepositoryProfile[];
    }
  | {
      status: "unavailable";
      reason: "no_profiles" | "profile_missing_queue";
    };

export interface ResolveTelegramExecutionRepositoryProfileInput {
  text: string;
  repositories: RepositoryProfile[];
  defaultRepository?: string;
}

export const resolveTelegramExecutionRepositoryProfile = (
  input: ResolveTelegramExecutionRepositoryProfileInput,
): TelegramRepositoryProfileResolution => {
  const executableProfiles = input.repositories
    .map(toExecutionProfile)
    .filter((profile): profile is TelegramExecutionRepositoryProfile => profile !== undefined);

  if (executableProfiles.length === 0) {
    return {
      status: "unavailable",
      reason: input.repositories.length === 0 ? "no_profiles" : "profile_missing_queue",
    };
  }

  const defaultProfile = input.defaultRepository
    ? executableProfiles.find((profile) => profile.repositoryName === input.defaultRepository)
    : undefined;
  if (defaultProfile) {
    return { status: "selected", profile: defaultProfile, reason: "default_repository" };
  }

  const textMatches = executableProfiles.filter((profile) =>
    profileMatchesText(profile, input.text),
  );
  if (textMatches.length === 1) {
    return { status: "selected", profile: textMatches[0]!, reason: "text_match" };
  }
  if (textMatches.length > 1) {
    return { status: "needs_selection", options: textMatches };
  }

  if (executableProfiles.length === 1) {
    return {
      status: "selected",
      profile: executableProfiles[0]!,
      reason: "single_profile",
    };
  }

  return { status: "needs_selection", options: executableProfiles };
};

const toExecutionProfile = (
  profile: RepositoryProfile,
): TelegramExecutionRepositoryProfile | undefined => {
  const queue = profile.queues[0]?.trim();
  if (!queue) {
    return undefined;
  }
  return {
    repositoryName: profile.name,
    repoPathKey: profile.name,
    baseBranch: profile.baseBranch,
    queue,
    tags: [...profile.tags],
  };
};

const profileMatchesText = (
  profile: TelegramExecutionRepositoryProfile,
  text: string,
): boolean => {
  const normalized = normalize(text);
  const tokens = [
    profile.repositoryName,
    profile.repoPathKey,
    profile.baseBranch,
    profile.queue,
    ...profile.tags,
  ].map(normalize).filter(Boolean);

  return tokens.some((token) => normalized.includes(token));
};

const normalize = (value: string): string => value.trim().toLowerCase();
```

- [ ] **Step 4: Export resolver**

Modify `src/domain/telegramAssistant/index.ts`:

```ts
export {
  resolveTelegramExecutionRepositoryProfile,
  type ResolveTelegramExecutionRepositoryProfileInput,
  type TelegramExecutionRepositoryProfile,
  type TelegramRepositoryProfileResolution,
} from "./repositoryProfileResolver.js";
```

- [ ] **Step 5: Run resolver tests**

Run:

```bash
npx vitest run tests/telegramExecutableTaskDraft.test.ts
```

Expected: pass.

---

### Task 2: Add Risk Classifier and Executable Draft Helpers

**Files:**
- Create: `src/domain/telegramAssistant/riskClassifier.ts`
- Create: `src/domain/telegramAssistant/executableTaskDraft.ts`
- Modify: `src/domain/telegramAssistant/types.ts`
- Modify: `src/domain/telegramAssistant/index.ts`
- Test: `tests/telegramExecutableTaskDraft.test.ts`

- [ ] **Step 1: Add failing tests for risk and draft readiness**

Append to `tests/telegramExecutableTaskDraft.test.ts`:

```ts
import {
  buildTelegramExecutableTaskDraft,
  classifyTelegramTaskRisk,
  nextExecutableDraftQuestion,
} from "../src/domain/telegramAssistant/index.js";

describe("classifyTelegramTaskRisk", () => {
  it("classifies docs and tests as low risk", () => {
    expect(classifyTelegramTaskRisk("добавь документацию по запуску")).toEqual({
      riskLevel: "low",
      reasons: ["documentation_or_tests"],
      requiresOwnerApproval: false,
    });
  });

  it("classifies isolated fixes as medium risk", () => {
    expect(classifyTelegramTaskRisk("почини ошибку в форме регистрации")).toEqual({
      riskLevel: "medium",
      reasons: ["isolated_feature_or_bugfix"],
      requiresOwnerApproval: false,
    });
  });

  it("classifies auth, payments, deletion and infra as high risk", () => {
    expect(classifyTelegramTaskRisk("удали пользователей и поменяй авторизацию")).toEqual({
      riskLevel: "high",
      reasons: ["security_or_auth", "destructive_data_change"],
      requiresOwnerApproval: true,
    });
  });
});

describe("buildTelegramExecutableTaskDraft", () => {
  it("builds an executable draft with selected profile and default acceptance criteria", () => {
    const selectedProfile = {
      repositoryName: "developer",
      repoPathKey: "developer",
      baseBranch: "main",
      queue: "DEV",
      tags: ["ai_dev"],
    };

    const draft = buildTelegramExecutableTaskDraft({
      text: "создай задачу починить регистрацию",
      selectedProfile,
    });

    expect(draft).toEqual(expect.objectContaining({
      title: "починить регистрацию",
      description: "создай задачу починить регистрацию",
      repositoryName: "developer",
      repoPathKey: "developer",
      baseBranch: "main",
      queue: "DEV",
      acceptanceCriteria: [
        "Поведение реализовано и покрыто существующими проверками.",
      ],
      tags: ["telegram", "ai_dev", "risk_medium"],
      risk: {
        riskLevel: "medium",
        reasons: ["isolated_feature_or_bugfix"],
        requiresOwnerApproval: false,
      },
    }));
    expect(nextExecutableDraftQuestion(draft)).toBeUndefined();
  });

  it("asks for repository selection when profile is missing", () => {
    const draft = buildTelegramExecutableTaskDraft({
      text: "создай задачу поправить форму",
    });

    expect(nextExecutableDraftQuestion(draft)).toEqual({
      field: "repositoryProfile",
      text: "В каком репозитории выполнить задачу?",
    });
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npx vitest run tests/telegramExecutableTaskDraft.test.ts
```

Expected: fail on missing exports.

- [ ] **Step 3: Add types**

Modify `src/domain/telegramAssistant/types.ts`:

```ts
export type TelegramTaskRiskLevel = "low" | "medium" | "high";

export interface TelegramTaskRiskAssessment {
  riskLevel: TelegramTaskRiskLevel;
  reasons: string[];
  requiresOwnerApproval: boolean;
}

export type TelegramExecutableTaskDraftSource = "private" | "business" | "twin";

export type TelegramExecutableTaskDraftStatus =
  | "collecting"
  | "awaiting_user_confirmation"
  | "awaiting_owner_approval"
  | "completed"
  | "cancelled"
  | "expired";

export type TelegramExecutableTaskDraftExecutionMode =
  | "auto_ready"
  | "owner_approval"
  | "triage_only";

export interface TelegramExecutableTaskDraft {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  repositoryName?: string;
  repoPathKey?: string;
  baseBranch?: string;
  queue?: string;
  tags: string[];
  risk: TelegramTaskRiskAssessment;
  executionMode: TelegramExecutableTaskDraftExecutionMode;
}

export interface TelegramExecutableTaskDraftQuestion {
  field: "repositoryProfile" | "acceptanceCriteria" | "description";
  text: string;
}

export interface TelegramExecutableTaskDraftSession {
  id: string;
  conversationKey: string;
  source: TelegramExecutableTaskDraftSource;
  initiatorUserId?: number;
  ownerUserId?: number;
  ownerChatId?: number;
  chatId: number;
  messageId?: number;
  originalText: string;
  draft: TelegramExecutableTaskDraft;
  status: TelegramExecutableTaskDraftStatus;
  clarificationQuestion?: TelegramExecutableTaskDraftQuestion;
  clarificationHistory: Array<{
    field: TelegramExecutableTaskDraftQuestion["field"];
    question: string;
    answer: string;
    answeredAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface TelegramActiveTaskQuestionPrompt {
  id: string;
  conversationKey: string;
  chatId: number;
  userId?: number;
  taskId: string;
  questionId: string;
  promptMessageId?: number;
  status: "open" | "answered" | "cancelled" | "expired";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
```

- [ ] **Step 4: Implement risk classifier**

Create `src/domain/telegramAssistant/riskClassifier.ts`:

```ts
import type { TelegramTaskRiskAssessment } from "./types.js";

const LOW_RISK_PATTERNS = [
  /документац|readme|docs?|комментар/i,
  /тест|spec|coverage/i,
  /текст|copy|опечатк|лейбл|label/i,
];

const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/auth|авторизац|аутентификац|permission|доступ|роль|security|секрет/i, "security_or_auth"],
  [/payment|billing|оплат|платеж|invoice|тариф/i, "payments_or_billing"],
  [/удали|delete|drop|truncate|миграц|migration|перенеси данные/i, "destructive_data_change"],
  [/infra|deploy|ci|cd|docker|kubernetes|secret|production|prod/i, "infrastructure_or_deployment"],
  [/рефактор|refactor|перепиши всё|переделай всё|улучши проект|сделай всё/i, "broad_or_ambiguous_scope"],
];

export const classifyTelegramTaskRisk = (
  text: string,
): TelegramTaskRiskAssessment => {
  const highReasons = HIGH_RISK_PATTERNS
    .filter(([pattern]) => pattern.test(text))
    .map(([, reason]) => reason);
  if (highReasons.length > 0) {
    return {
      riskLevel: "high",
      reasons: [...new Set(highReasons)],
      requiresOwnerApproval: true,
    };
  }

  if (LOW_RISK_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      riskLevel: "low",
      reasons: ["documentation_or_tests"],
      requiresOwnerApproval: false,
    };
  }

  return {
    riskLevel: "medium",
    reasons: ["isolated_feature_or_bugfix"],
    requiresOwnerApproval: false,
  };
};
```

- [ ] **Step 5: Implement executable draft helpers**

Create `src/domain/telegramAssistant/executableTaskDraft.ts`:

```ts
import type { TelegramExecutionRepositoryProfile } from "./repositoryProfileResolver.js";
import { classifyTelegramTaskRisk } from "./riskClassifier.js";
import type {
  TelegramExecutableTaskDraft,
  TelegramExecutableTaskDraftExecutionMode,
  TelegramExecutableTaskDraftQuestion,
} from "./types.js";

export interface BuildTelegramExecutableTaskDraftInput {
  text: string;
  selectedProfile?: TelegramExecutionRepositoryProfile;
  forceOwnerApproval?: boolean;
}

export const buildTelegramExecutableTaskDraft = (
  input: BuildTelegramExecutableTaskDraftInput,
): TelegramExecutableTaskDraft => {
  const title = buildTitle(input.text);
  const risk = classifyTelegramTaskRisk(input.text);
  const executionMode = decideExecutionMode(risk.requiresOwnerApproval, input.forceOwnerApproval);

  return {
    title,
    description: input.text,
    acceptanceCriteria: [
      "Поведение реализовано и покрыто существующими проверками.",
    ],
    ...(input.selectedProfile
      ? {
          repositoryName: input.selectedProfile.repositoryName,
          repoPathKey: input.selectedProfile.repoPathKey,
          baseBranch: input.selectedProfile.baseBranch,
          queue: input.selectedProfile.queue,
        }
      : {}),
    tags: [
      "telegram",
      ...(input.selectedProfile?.tags ?? []),
      `risk_${risk.riskLevel}`,
    ],
    risk,
    executionMode,
  };
};

export const nextExecutableDraftQuestion = (
  draft: TelegramExecutableTaskDraft,
): TelegramExecutableTaskDraftQuestion | undefined => {
  if (!draft.repositoryName || !draft.repoPathKey || !draft.baseBranch || !draft.queue) {
    return {
      field: "repositoryProfile",
      text: "В каком репозитории выполнить задачу?",
    };
  }
  if (draft.acceptanceCriteria.length === 0) {
    return {
      field: "acceptanceCriteria",
      text: "Как понять, что задача выполнена? Назови 1-3 критерия приемки.",
    };
  }
  if (draft.description.trim().length < 12) {
    return {
      field: "description",
      text: "Опиши задачу чуть подробнее: что нужно изменить и где это проверить?",
    };
  }
  return undefined;
};

const decideExecutionMode = (
  requiresOwnerApproval: boolean,
  forceOwnerApproval: boolean | undefined,
): TelegramExecutableTaskDraftExecutionMode => {
  if (requiresOwnerApproval || forceOwnerApproval === true) {
    return "owner_approval";
  }
  return "auto_ready";
};

const buildTitle = (text: string): string => {
  const cleaned = text
    .replace(/^(надо сделать|создай задачу|заведи задачу|сделай|почини|добавь)\s*:?\s*/i, "")
    .trim();
  if (!cleaned) {
    return "Задача из Telegram";
  }
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
};
```

- [ ] **Step 6: Export helpers**

Modify `src/domain/telegramAssistant/index.ts`:

```ts
export {
  buildTelegramExecutableTaskDraft,
  nextExecutableDraftQuestion,
  type BuildTelegramExecutableTaskDraftInput,
} from "./executableTaskDraft.js";
export {
  classifyTelegramTaskRisk,
} from "./riskClassifier.js";
export type {
  TelegramActiveTaskQuestionPrompt,
  TelegramExecutableTaskDraft,
  TelegramExecutableTaskDraftExecutionMode,
  TelegramExecutableTaskDraftQuestion,
  TelegramExecutableTaskDraftSession,
  TelegramExecutableTaskDraftSource,
  TelegramExecutableTaskDraftStatus,
  TelegramTaskRiskAssessment,
  TelegramTaskRiskLevel,
} from "./types.js";
```

- [ ] **Step 7: Run tests**

Run:

```bash
npx vitest run tests/telegramExecutableTaskDraft.test.ts
npm run typecheck
```

Expected: pass.

---

### Task 3: Persist Draft Sessions and Active Task Questions

**Files:**
- Modify: `src/domain/telegramAssistant/store.ts`
- Modify: `src/domain/telegramAssistant/postgresStore.ts`
- Create: `src/integrations/internalTracker/migrations/0015_telegram_executable_task_intake.sql`
- Modify: `src/domain/telegramAssistant/index.ts`
- Test: `tests/telegramStore.test.ts`
- Test: `tests/telegramPostgresStore.test.ts`

- [ ] **Step 1: Add failing in-memory store tests**

Append to `tests/telegramStore.test.ts`:

```ts
import type {
  TelegramActiveTaskQuestionPrompt,
  TelegramExecutableTaskDraftSession,
} from "../src/domain/telegramAssistant/index.js";

const draftSession = (
  overrides: Partial<TelegramExecutableTaskDraftSession> = {},
): TelegramExecutableTaskDraftSession => ({
  id: "draft-1",
  conversationKey,
  source: "private",
  initiatorUserId: 200,
  chatId: 100,
  messageId: 300,
  originalText: "создай задачу починить регистрацию",
  draft: {
    title: "починить регистрацию",
    description: "создай задачу починить регистрацию",
    acceptanceCriteria: ["Поведение реализовано."],
    repositoryName: "developer",
    repoPathKey: "developer",
    baseBranch: "main",
    queue: "DEV",
    tags: ["telegram", "ai_dev", "risk_medium"],
    risk: {
      riskLevel: "medium",
      reasons: ["isolated_feature_or_bugfix"],
      requiresOwnerApproval: false,
    },
    executionMode: "auto_ready",
  },
  status: "collecting",
  clarificationHistory: [],
  createdAt: baseTime,
  updatedAt: baseTime,
  expiresAt: futureTime,
  ...overrides,
});

const activeQuestionPrompt = (
  overrides: Partial<TelegramActiveTaskQuestionPrompt> = {},
): TelegramActiveTaskQuestionPrompt => ({
  id: "question-prompt-1",
  conversationKey,
  chatId: 100,
  userId: 200,
  taskId: "task_1",
  questionId: "question_1",
  status: "open",
  createdAt: baseTime,
  updatedAt: baseTime,
  expiresAt: futureTime,
  ...overrides,
});

it("stores and lists executable draft sessions by conversation", async () => {
  const store = createStore();
  await store.upsertExecutableTaskDraftSession(draftSession());

  await expect(store.getExecutableTaskDraftSession("draft-1")).resolves.toEqual(draftSession());
  await expect(store.getActiveExecutableTaskDraftSession(conversationKey)).resolves.toEqual(draftSession());

  await store.completeExecutableTaskDraftSession("draft-1", {
    status: "cancelled",
    updatedAt: laterTime,
  });

  await expect(store.getActiveExecutableTaskDraftSession(conversationKey)).resolves.toBeUndefined();
});

it("stores active task question prompts and consumes them once", async () => {
  const store = createStore();
  await store.upsertActiveTaskQuestionPrompt(activeQuestionPrompt());

  await expect(store.getActiveTaskQuestionPrompt(conversationKey)).resolves.toEqual(activeQuestionPrompt());

  const consumed = await store.consumeActiveTaskQuestionPrompt({
    conversationKey,
    chatId: 100,
    userId: 200,
    answeredAt: laterTime,
  });

  expect(consumed).toEqual(activeQuestionPrompt());
  await expect(store.getActiveTaskQuestionPrompt(conversationKey)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Add store interface methods**

Modify `src/domain/telegramAssistant/store.ts` imports and interfaces:

```ts
import type {
  TelegramActiveTaskQuestionPrompt,
  TelegramExecutableTaskDraftSession,
  TelegramExecutableTaskDraftStatus,
  // existing imports...
} from "./types.js";

export interface CompleteExecutableTaskDraftSessionInput {
  status: Extract<
    TelegramExecutableTaskDraftStatus,
    "completed" | "cancelled" | "expired"
  >;
  updatedAt?: string;
}

export interface ConsumeActiveTaskQuestionPromptInput {
  conversationKey: string;
  chatId: number;
  userId?: number;
  answeredAt?: string;
}

export interface TelegramAssistantStore {
  // keep existing methods
  upsertExecutableTaskDraftSession(
    session: TelegramExecutableTaskDraftSession,
  ): Promise<TelegramExecutableTaskDraftSession>;
  getExecutableTaskDraftSession(
    sessionId: string,
  ): Promise<TelegramExecutableTaskDraftSession | undefined>;
  getActiveExecutableTaskDraftSession(
    conversationKey: string,
  ): Promise<TelegramExecutableTaskDraftSession | undefined>;
  completeExecutableTaskDraftSession(
    sessionId: string,
    input: CompleteExecutableTaskDraftSessionInput,
  ): Promise<TelegramExecutableTaskDraftSession>;
  upsertActiveTaskQuestionPrompt(
    prompt: TelegramActiveTaskQuestionPrompt,
  ): Promise<TelegramActiveTaskQuestionPrompt>;
  getActiveTaskQuestionPrompt(
    conversationKey: string,
  ): Promise<TelegramActiveTaskQuestionPrompt | undefined>;
  consumeActiveTaskQuestionPrompt(
    input: ConsumeActiveTaskQuestionPromptInput,
  ): Promise<TelegramActiveTaskQuestionPrompt | undefined>;
}
```

- [ ] **Step 3: Implement in-memory methods**

Modify `InMemoryTelegramAssistantStore`:

```ts
private readonly executableTaskDraftSessions =
  new Map<string, TelegramExecutableTaskDraftSession>();
private readonly activeTaskQuestionPrompts =
  new Map<string, TelegramActiveTaskQuestionPrompt>();

public async upsertExecutableTaskDraftSession(
  session: TelegramExecutableTaskDraftSession,
): Promise<TelegramExecutableTaskDraftSession> {
  this.executableTaskDraftSessions.set(session.id, clone(session));
  return clone(session);
}

public async getExecutableTaskDraftSession(
  sessionId: string,
): Promise<TelegramExecutableTaskDraftSession | undefined> {
  const session = this.executableTaskDraftSessions.get(sessionId);
  return session ? clone(session) : undefined;
}

public async getActiveExecutableTaskDraftSession(
  conversationKey: string,
): Promise<TelegramExecutableTaskDraftSession | undefined> {
  const now = this.nowIso();
  const session = [...this.executableTaskDraftSessions.values()]
    .filter((candidate) =>
      candidate.conversationKey === conversationKey &&
      (candidate.status === "collecting" ||
        candidate.status === "awaiting_user_confirmation" ||
        candidate.status === "awaiting_owner_approval") &&
      !isExpired(candidate.expiresAt, now),
    )
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.id.localeCompare(left.id),
    )[0];
  return session ? clone(session) : undefined;
}

public async completeExecutableTaskDraftSession(
  sessionId: string,
  input: CompleteExecutableTaskDraftSessionInput,
): Promise<TelegramExecutableTaskDraftSession> {
  const existing = this.executableTaskDraftSessions.get(sessionId);
  if (!existing) {
    throw new Error(`Telegram executable task draft session not found: ${sessionId}`);
  }
  const updatedAt = input.updatedAt ?? this.nowIso();
  const updated: TelegramExecutableTaskDraftSession = {
    ...existing,
    status: input.status,
    updatedAt,
  };
  this.executableTaskDraftSessions.set(sessionId, clone(updated));
  return clone(updated);
}

public async upsertActiveTaskQuestionPrompt(
  prompt: TelegramActiveTaskQuestionPrompt,
): Promise<TelegramActiveTaskQuestionPrompt> {
  this.activeTaskQuestionPrompts.set(prompt.id, clone(prompt));
  return clone(prompt);
}

public async getActiveTaskQuestionPrompt(
  conversationKey: string,
): Promise<TelegramActiveTaskQuestionPrompt | undefined> {
  const now = this.nowIso();
  const prompt = [...this.activeTaskQuestionPrompts.values()]
    .filter((candidate) =>
      candidate.conversationKey === conversationKey &&
      candidate.status === "open" &&
      !isExpired(candidate.expiresAt, now),
    )
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.id.localeCompare(left.id),
    )[0];
  return prompt ? clone(prompt) : undefined;
}

public async consumeActiveTaskQuestionPrompt(
  input: ConsumeActiveTaskQuestionPromptInput,
): Promise<TelegramActiveTaskQuestionPrompt | undefined> {
  const existing = await this.getActiveTaskQuestionPrompt(input.conversationKey);
  if (
    !existing ||
    existing.chatId !== input.chatId ||
    (existing.userId !== undefined && input.userId !== existing.userId)
  ) {
    return undefined;
  }
  const answeredAt = input.answeredAt ?? this.nowIso();
  const updated: TelegramActiveTaskQuestionPrompt = {
    ...existing,
    status: "answered",
    updatedAt: answeredAt,
  };
  this.activeTaskQuestionPrompts.set(existing.id, clone(updated));
  return clone(existing);
}
```

- [ ] **Step 4: Add migration**

Create `src/integrations/internalTracker/migrations/0015_telegram_executable_task_intake.sql`:

```sql
-- Telegram executable task intake persistence.

CREATE TABLE IF NOT EXISTS telegram_executable_task_draft_sessions (
  id text PRIMARY KEY,
  conversation_key text NOT NULL,
  source text NOT NULL,
  initiator_user_id bigint,
  owner_user_id bigint,
  owner_chat_id bigint,
  chat_id bigint NOT NULL,
  message_id bigint,
  original_text text NOT NULL,
  draft jsonb NOT NULL,
  status text NOT NULL,
  clarification_question jsonb,
  clarification_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (source IN ('private', 'business', 'twin')),
  CHECK (status IN (
    'collecting',
    'awaiting_user_confirmation',
    'awaiting_owner_approval',
    'completed',
    'cancelled',
    'expired'
  ))
);

CREATE INDEX IF NOT EXISTS telegram_executable_task_draft_sessions_active_idx
  ON telegram_executable_task_draft_sessions(conversation_key, status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS telegram_executable_task_draft_sessions_expiry_idx
  ON telegram_executable_task_draft_sessions(expires_at, status);

CREATE TABLE IF NOT EXISTS telegram_active_task_question_prompts (
  id text PRIMARY KEY,
  conversation_key text NOT NULL,
  chat_id bigint NOT NULL,
  user_id bigint,
  task_id text NOT NULL,
  question_id text NOT NULL,
  prompt_message_id bigint,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (status IN ('open', 'answered', 'cancelled', 'expired'))
);

CREATE INDEX IF NOT EXISTS telegram_active_task_question_prompts_conversation_idx
  ON telegram_active_task_question_prompts(conversation_key, status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS telegram_active_task_question_prompts_task_idx
  ON telegram_active_task_question_prompts(task_id, question_id, status);
```

- [ ] **Step 5: Implement PostgreSQL mapping methods**

Modify `src/domain/telegramAssistant/postgresStore.ts` by adding row types, mappers and SQL methods mirroring the in-memory behavior. Use the existing `jsonValue`, `toIso`, `optionalIso`, `toNumber`, transaction and `nowIso()` patterns. The methods must use these SQL operations:

```ts
await this.db.query(
  `INSERT INTO telegram_executable_task_draft_sessions (
     id, conversation_key, source, initiator_user_id, owner_user_id,
     owner_chat_id, chat_id, message_id, original_text, draft, status,
     clarification_question, clarification_history, created_at, updated_at,
     expires_at
   )
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
   ON CONFLICT (id) DO UPDATE SET
     draft = EXCLUDED.draft,
     status = EXCLUDED.status,
     clarification_question = EXCLUDED.clarification_question,
     clarification_history = EXCLUDED.clarification_history,
     updated_at = EXCLUDED.updated_at,
     expires_at = EXCLUDED.expires_at
   RETURNING *`,
  [
    session.id,
    session.conversationKey,
    session.source,
    session.initiatorUserId ?? null,
    session.ownerUserId ?? null,
    session.ownerChatId ?? null,
    session.chatId,
    session.messageId ?? null,
    session.originalText,
    JSON.stringify(session.draft),
    session.status,
    session.clarificationQuestion ? JSON.stringify(session.clarificationQuestion) : null,
    JSON.stringify(session.clarificationHistory),
    session.createdAt,
    session.updatedAt,
    session.expiresAt,
  ],
);
```

Also add equivalent SQL for `telegram_active_task_question_prompts`.

- [ ] **Step 6: Add PostgreSQL store tests**

Append lightweight mapping tests to `tests/telegramPostgresStore.test.ts` using a fake `db.query` like existing tests. Assert:

```ts
expect(text).toContain("telegram_executable_task_draft_sessions");
expect(values).toContain("draft-1");
expect(values).toContain("bot_private:100:200");
```

Add an integration test inside `describePostgres` if `TEST_DATABASE_URL` is set:

```ts
it("persists executable draft sessions in postgres", async () => {
  const store = new PostgresTelegramAssistantStore(pg);
  await store.upsertExecutableTaskDraftSession(draftSession());
  await expect(store.getExecutableTaskDraftSession("draft-1")).resolves.toEqual(draftSession());
});
```

- [ ] **Step 7: Run store tests**

Run:

```bash
npx vitest run tests/telegramStore.test.ts tests/telegramPostgresStore.test.ts
npm run typecheck
```

Expected: pass.

---

### Task 4: Implement Private Executable Intake Flow

**Files:**
- Modify: `src/domain/telegramAssistant/service.ts`
- Modify: `src/domain/telegramAssistant/taskDraftBuilder.ts`
- Test: `tests/telegramAssistant.test.ts`
- Test: `tests/taskTrackerQueue.test.ts`

- [ ] **Step 1: Add failing private executable intake test**

Replace the current expectation in `tests/telegramAssistant.test.ts` test `"creates an internal task from a confirmed draft without idempotencyKey"` or add a new test:

```ts
it("creates a ready executable task from a confirmed trusted private draft", async () => {
  const sendMessage = vi.fn();
  const store = new InMemoryTelegramAssistantStore({
    now: () => new Date("2026-05-30T08:00:00.000Z"),
  });
  const taskTracker = new InMemoryTaskTrackerClient({
    now: () => new Date("2026-05-30T08:00:00.000Z"),
  });
  const createTaskSpy = vi.spyOn(taskTracker, "createTask");
  const markReadySpy = vi.spyOn(taskTracker, "markReady");
  const service = new TelegramAssistantService({
    store,
    config: {
      ...baseTelegramAssistantConfig(),
      defaultRepository: "developer",
    },
    taskTracker,
    repositories: [repositoryFixture()],
    telegram: { sendMessage, answerCallbackQuery: vi.fn() },
  });

  await service.handleUpdate(messageUpdate("создай задачу починить регистрацию", {
    updateId: 36,
    messageId: 99,
  }));
  await service.handleUpdate(messageUpdate("да", {
    updateId: 37,
    messageId: 100,
    date: 2,
  }));

  expect(createTaskSpy).toHaveBeenCalledOnce();
  expect(createTaskSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
    title: "починить регистрацию",
    repositoryName: "developer",
    repoPathKey: "developer",
    baseBranch: "main",
    queue: "DEV",
    tags: expect.arrayContaining(["telegram", "ai_dev", "risk_medium"]),
    acceptanceCriteria: [
      "Поведение реализовано и покрыто существующими проверками.",
    ],
    riskFactors: ["isolated_feature_or_bugfix"],
    externalRefs: [{ provider: "telegram", externalKey: "telegram:1:99" }],
  }));
  expect(markReadySpy).toHaveBeenCalledOnce();

  const [subscription] = await store.listTaskSubscriptions("bot_private:1");
  expect(subscription?.taskId).toMatch(/^task_/);
  expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
    text: expect.stringContaining("поставлена в очередь"),
  }));
});
```

- [ ] **Step 2: Add failing runtime flag tests**

Add:

```ts
it("blocks Telegram task creation when taskCreationEnabled is false", async () => {
  const sendMessage = vi.fn();
  const store = new InMemoryTelegramAssistantStore();
  const taskTracker = fakeTaskTracker(taskFixture());
  const service = buildAssistant({
    store,
    taskTracker,
    sendMessage,
    config: {
      ...baseTelegramAssistantConfig(),
      taskCreationEnabled: false,
    },
  });

  await service.handleUpdate(messageUpdate("создай задачу починить регистрацию"));

  expect(taskTracker.createTask).not.toHaveBeenCalled();
  await expect(store.listPendingActions()).resolves.toEqual([]);
  await expect(store.getActiveExecutableTaskDraftSession("bot_private:1")).resolves.toBeUndefined();
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    text: expect.stringContaining("создание задач выключено"),
  }));
});
```

Use the existing local fake task tracker helpers in `telegramAssistant.test.ts`.

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
npx vitest run tests/telegramAssistant.test.ts tests/taskTrackerQueue.test.ts
```

Expected: fail because service still creates non-executable draft pending actions.

- [ ] **Step 4: Enforce task creation flag before creating draft sessions**

In `handleCreateTaskDraft`, add first:

```ts
if (!this.config.taskCreationEnabled) {
  await this.sendPlainMessage(message, "Создание задач через Telegram сейчас выключено.");
  return;
}
```

- [ ] **Step 5: Build executable draft session in `handleCreateTaskDraft`**

Replace direct `buildHeuristicTaskDraft` pending action construction with:

```ts
const repositoryResolution = resolveTelegramExecutionRepositoryProfile({
  text,
  repositories: this.repositories,
  defaultRepository: this.config.defaultRepository,
});

if (repositoryResolution.status === "unavailable") {
  await this.sendPlainMessage(
    message,
    "Не могу поставить задачу в очередь: не настроен repository profile для выполнения.",
  );
  return;
}

if (repositoryResolution.status === "needs_selection") {
  await this.createExecutableTaskDraftSession(message, intent, text, {
    repositoryOptions: repositoryResolution.options,
  });
  await this.sendPlainMessage(
    message,
    "В каком репозитории выполнить задачу? Ответь названием репозитория или queue.",
  );
  return;
}

const draft = buildTelegramExecutableTaskDraft({
  text,
  selectedProfile: repositoryResolution.profile,
});
const nextQuestion = nextExecutableDraftQuestion(draft);
const session = await this.store.upsertExecutableTaskDraftSession({
  id: buildExecutableDraftSessionId(message.updateId, message.messageId),
  conversationKey: message.conversationKey,
  source: "private",
  initiatorUserId: message.userId,
  chatId: message.chatId,
  messageId: message.messageId,
  originalText: text,
  draft,
  status: nextQuestion ? "collecting" : "awaiting_user_confirmation",
  ...(nextQuestion ? { clarificationQuestion: nextQuestion } : {}),
  clarificationHistory: [],
  createdAt: now,
  updatedAt: now,
  expiresAt: addDays(now, this.config.conversationRetentionDays),
});

if (nextQuestion) {
  await this.sendPlainMessage(message, nextQuestion.text);
  return;
}

await this.createExecutableTaskPendingActionFromSession(message, intent, session);
```

Import new helpers from `repositoryProfileResolver.js` and `executableTaskDraft.js`.

- [ ] **Step 6: Add service helper for pending action payload**

Add private helper:

```ts
private async createExecutableTaskPendingActionFromSession(
  message: TelegramInboundMessage,
  intent: TelegramIntent,
  session: TelegramExecutableTaskDraftSession,
): Promise<void> {
  if (message.messageId === undefined || message.userId === undefined) {
    await this.sendPlainMessage(
      message,
      "Не могу создать задачу: не удалось определить сообщение или пользователя.",
    );
    return;
  }

  const actionId = buildPendingActionId(message.updateId, message.messageId);
  const externalKey = buildTelegramExternalKey(session.chatId, session.messageId ?? message.messageId);
  const now = new Date().toISOString();
  const pendingAction: TelegramPendingAction = {
    id: actionId,
    conversationKey: message.conversationKey,
    chatId: message.chatId,
    userId: message.userId,
    intent,
    payload: {
      draft: session.draft,
      sessionId: session.id,
      executionMode: session.draft.executionMode,
      chatId: session.chatId,
      messageId: session.messageId ?? message.messageId,
      userId: session.initiatorUserId ?? message.userId,
      externalKey,
      ...(message.attachments && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
    },
    status: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt: addDays(now, this.config.conversationRetentionDays),
  };

  await this.store.upsertPendingAction(pendingAction);
  await this.updatePendingActionGauges();
  await this.sendTelegramResponse(
    message,
    buildExecutableTaskDraftResponse(session.draft, pendingAction.id),
  );
}
```

- [ ] **Step 7: Add executable task response renderer**

Near `buildTaskDraftResponse`, add:

```ts
const buildExecutableTaskDraftResponse = (
  draft: TelegramExecutableTaskDraft,
  actionId: string,
): TelegramResponse => ({
  blocks: [
    { kind: "title", text: "Создать и запустить задачу?" },
    { kind: "paragraph", text: draft.title },
    { kind: "paragraph", text: `Репозиторий: ${draft.repositoryName ?? "-"} / ${draft.queue ?? "-"}` },
    { kind: "paragraph", text: `Риск: ${draft.risk.riskLevel} (${draft.risk.reasons.join(", ")})` },
    { kind: "paragraph", text: draft.executionMode === "auto_ready"
      ? "После подтверждения задача будет поставлена в очередь."
      : "После подтверждения потребуется owner/admin approval." },
  ],
  replyMarkup: {
    inline_keyboard: [
      [
        { text: "Создать и запустить", callback_data: `c:${actionId}` },
        { text: "Отмена", callback_data: `cancel:${actionId}` },
      ],
    ],
  },
});
```

- [ ] **Step 8: Create task with execution fields and mark ready**

Update `findOrCreateTaskFromPendingAction` to parse executable draft payload and include:

```ts
const task = await this.taskTracker.createTask({
  title: payload.draft.title,
  description: payload.draft.description,
  source: {
    kind: "system",
    provider: "telegram",
    externalKey: payload.externalKey,
  },
  createdBy: {
    owner: "external_source",
    id: "telegram",
    displayName: "Telegram Assistant",
  },
  repositoryName: payload.draft.repositoryName,
  repoPathKey: payload.draft.repoPathKey,
  baseBranch: payload.draft.baseBranch,
  queue: payload.draft.queue,
  tags: payload.draft.tags,
  acceptanceCriteria: payload.draft.acceptanceCriteria,
  riskFactors: payload.draft.risk.reasons,
  externalRefs: [
    { provider: "telegram", externalKey: payload.externalKey },
  ],
  externalSnapshot: {
    chatId: payload.chatId,
    messageId: payload.messageId,
    userId: payload.userId,
    executionMode: payload.executionMode,
    risk: payload.draft.risk,
    ...(payload.attachments && payload.attachments.length > 0
      ? { attachments: payload.attachments }
      : {}),
  },
});
if (payload.executionMode === "auto_ready") {
  await this.taskTracker.markReady(task.id, "Telegram task approved for execution.");
  return this.taskTracker.getTask(task.id);
}
return task;
```

Keep the existing `DuplicateExternalRefError` recovery. If an existing task is found and `payload.executionMode === "auto_ready"` but existing status is `new` or `triage`, call `markReady` once.

- [ ] **Step 9: Update final confirmation message**

In `completeCreateTaskAction`, send:

```ts
await this.sendPlainMessage(
  message,
  task.status === "ready" || task.status === "claimed"
    ? `Задача создана и поставлена в очередь: ${task.id}`
    : `Задача создана для triage: ${task.id}`,
);
```

- [ ] **Step 10: Add claimability regression**

Add to `tests/taskTrackerQueue.test.ts`:

```ts
it("claims Telegram-created ready tasks with execution fields", async () => {
  const client = new InMemoryTaskTrackerClient();
  const task = await client.createTask({
    ...baseTaskInput({
      source: { kind: "system", provider: "telegram", externalKey: "telegram:1:99" },
      repositoryName: "developer",
      repoPathKey: "developer",
      baseBranch: "main",
      queue: "DEV",
      tags: ["telegram", "ai_dev"],
      status: "ready",
    }),
  });

  const claim = await client.claimTask({
    workerId: "worker-1",
    repositoryProfiles: [{ name: "developer", queues: ["DEV"], tags: ["ai_dev"] }],
    leaseTtlSeconds: 60,
  });

  expect(claim?.task.id).toBe(task.id);
});
```

- [ ] **Step 11: Run focused tests**

Run:

```bash
npx vitest run tests/telegramAssistant.test.ts tests/taskTrackerQueue.test.ts tests/telegramExecutableTaskDraft.test.ts
npm run typecheck
```

Expected: pass.

---

### Task 5: Add Clarification Loop for Incomplete or Ambiguous Drafts

**Files:**
- Modify: `src/domain/telegramAssistant/service.ts`
- Modify: `src/domain/telegramAssistant/executableTaskDraft.ts`
- Test: `tests/telegramAssistant.test.ts`

- [ ] **Step 1: Add failing tests**

Add tests:

```ts
it("asks for repository selection instead of creating a task when profiles are ambiguous", async () => {
  const sendMessage = vi.fn();
  const store = new InMemoryTelegramAssistantStore();
  const taskTracker = fakeTaskTracker(taskFixture());
  const service = buildAssistant({
    store,
    taskTracker,
    sendMessage,
    repositories: [
      repositoryFixture({ name: "frontend", queues: ["FRONTEND"] }),
      repositoryFixture({ name: "backend", queues: ["BACKEND"] }),
    ],
  });

  await service.handleUpdate(messageUpdate("создай задачу поправить текст"));

  expect(taskTracker.createTask).not.toHaveBeenCalled();
  await expect(store.getActiveExecutableTaskDraftSession("bot_private:1"))
    .resolves.toMatchObject({
      status: "collecting",
      clarificationQuestion: { field: "repositoryProfile" },
    });
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    text: expect.stringContaining("В каком репозитории"),
  }));
});

it("applies repository clarification answer and then asks for confirmation", async () => {
  const sendMessage = vi.fn();
  const store = new InMemoryTelegramAssistantStore();
  const taskTracker = fakeTaskTracker(taskFixture());
  const service = buildAssistant({
    store,
    taskTracker,
    sendMessage,
    repositories: [
      repositoryFixture({ name: "frontend", queues: ["FRONTEND"] }),
      repositoryFixture({ name: "backend", queues: ["BACKEND"] }),
    ],
  });

  await service.handleUpdate(messageUpdate("создай задачу поправить текст", {
    updateId: 10,
    messageId: 20,
  }));
  await service.handleUpdate(messageUpdate("frontend", {
    updateId: 11,
    messageId: 21,
  }));

  const [action] = await store.listPendingActions({
    conversationKey: "bot_private:1",
    status: "pending",
  });
  expect(action?.payload).toEqual(expect.objectContaining({
    draft: expect.objectContaining({
      repositoryName: "frontend",
      queue: "FRONTEND",
    }),
  }));
  expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
    text: expect.stringContaining("Создать и запустить задачу"),
  }));
});
```

- [ ] **Step 2: Add draft answer helper**

In `src/domain/telegramAssistant/executableTaskDraft.ts`, add:

```ts
export const applyExecutableDraftAnswer = (
  draft: TelegramExecutableTaskDraft,
  question: TelegramExecutableTaskDraftQuestion,
  answer: string,
  profiles: TelegramExecutionRepositoryProfile[],
): TelegramExecutableTaskDraft => {
  if (question.field === "repositoryProfile") {
    const selected = profiles.find((profile) =>
      [profile.repositoryName, profile.queue, profile.repoPathKey]
        .map((value) => value.toLowerCase())
        .includes(answer.trim().toLowerCase()),
    );
    if (!selected) {
      return draft;
    }
    return {
      ...draft,
      repositoryName: selected.repositoryName,
      repoPathKey: selected.repoPathKey,
      baseBranch: selected.baseBranch,
      queue: selected.queue,
      tags: [...new Set([...draft.tags, ...selected.tags])],
    };
  }
  if (question.field === "acceptanceCriteria") {
    return {
      ...draft,
      acceptanceCriteria: answer
        .split(/\n|;/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3),
    };
  }
  return {
    ...draft,
    description: `${draft.description}\n\nУточнение: ${answer.trim()}`,
  };
};
```

- [ ] **Step 3: Check active draft session before intent routing**

In `handleMessageUnderConversationLock`, before `routeTelegramIntent`, add:

```ts
const activeDraftSession = await this.store.getActiveExecutableTaskDraftSession(
  message.conversationKey,
);
if (activeDraftSession && message.text) {
  await this.handleExecutableDraftClarification(message, activeDraftSession);
  return undefined;
}
```

Keep reject/cancel handling before applying the answer if the message text is `нет` or `отмена`.

- [ ] **Step 4: Implement `handleExecutableDraftClarification`**

Add:

```ts
private async handleExecutableDraftClarification(
  message: TelegramInboundMessage,
  session: TelegramExecutableTaskDraftSession,
): Promise<void> {
  const question = session.clarificationQuestion;
  if (!question || !message.text) {
    return;
  }
  const profiles = this.repositories
    .map((repository) => resolveTelegramExecutionRepositoryProfile({
      text: repository.name,
      repositories: [repository],
    }))
    .flatMap((resolution) =>
      resolution.status === "selected" ? [resolution.profile] : [],
    );
  const updatedDraft = applyExecutableDraftAnswer(
    session.draft,
    question,
    message.text,
    profiles,
  );
  const nextQuestion = nextExecutableDraftQuestion(updatedDraft);
  const now = new Date().toISOString();
  const updatedSession: TelegramExecutableTaskDraftSession = {
    ...session,
    draft: updatedDraft,
    status: nextQuestion ? "collecting" : "awaiting_user_confirmation",
    ...(nextQuestion ? { clarificationQuestion: nextQuestion } : {}),
    clarificationHistory: [
      ...session.clarificationHistory,
      {
        field: question.field,
        question: question.text,
        answer: message.text,
        answeredAt: now,
      },
    ],
    updatedAt: now,
  };
  await this.store.upsertExecutableTaskDraftSession(updatedSession);
  if (nextQuestion) {
    await this.sendPlainMessage(message, nextQuestion.text);
    return;
  }
  await this.createExecutableTaskPendingActionFromSession(
    message,
    {
      name: "create_task_draft",
      confidence: 1,
      rawText: session.originalText,
      requiresConfirmation: true,
      safetyLevel: "confirm_write",
    },
    updatedSession,
  );
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx vitest run tests/telegramAssistant.test.ts tests/telegramExecutableTaskDraft.test.ts
npm run typecheck
```

Expected: pass.

---

### Task 6: Improve Lifecycle Notifications and Active Question Resume

**Files:**
- Modify: `src/domain/telegramAssistant/notificationRouter.ts`
- Modify: `src/domain/telegramAssistant/service.ts`
- Test: `tests/telegramNotifications.test.ts`
- Test: `tests/telegramAssistant.test.ts`

- [ ] **Step 1: Add failing notification rendering tests**

In `tests/telegramNotifications.test.ts`, add:

```ts
it("renders MR ready and done events as product-level lifecycle messages", async () => {
  const store = new InMemoryTelegramAssistantStore();
  await store.upsertTaskSubscription({
    id: "sub-lifecycle",
    taskId: "TASK-4",
    conversationKey: "bot_private:104",
    chatId: 104,
    createdAt: baseTime,
    updatedAt: baseTime,
  });
  const task = taskFixture({
    id: "TASK-4",
    status: "done",
    events: [
      taskEvent({
        id: "event-mr",
        taskId: "TASK-4",
        kind: "merge_request_recorded",
        message: "https://gitlab.example/mr/1",
        payload: { mergeRequestUrl: "https://gitlab.example/mr/1", mergeRequestIid: 1 },
      }),
      taskEvent({
        id: "event-done",
        taskId: "TASK-4",
        kind: "task_status_changed",
        message: "Task accepted.",
        payload: { to: "done" },
        createdAt: laterTime,
      }),
    ],
  });
  const sendMessage = vi.fn(async () => telegramMessage(9004, 104));
  const router = new TelegramNotificationRouter({
    store,
    taskTracker: { getTask: vi.fn(async () => task) },
    telegram: { sendMessage },
    clock: () => new Date(baseTime),
  });

  await router.scanSubscribedTasks();

  expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
    text: expect.stringContaining("Реализация готова"),
  }));
  expect(sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
    text: expect.stringContaining("Задача завершена"),
  }));
});

it("stores active task question prompt when a subscribed task waits for human answer", async () => {
  const store = new InMemoryTelegramAssistantStore();
  await store.upsertTaskSubscription({
    id: "sub-question",
    taskId: "TASK-5",
    conversationKey: "bot_private:105",
    chatId: 105,
    userId: 205,
    createdAt: baseTime,
    updatedAt: baseTime,
  });
  const task = taskFixture({
    id: "TASK-5",
    status: "awaiting_human",
    clarificationQuestions: [{
      id: "question-1",
      taskId: "TASK-5",
      workerId: "worker-1",
      question: { text: "Какой вариант выбрать?", options: ["A", "B"] },
      status: "open",
      createdAt: baseTime,
    }],
    events: [
      taskEvent({
        id: "event-question",
        taskId: "TASK-5",
        kind: "task_status_changed",
        payload: { to: "awaiting_human" },
      }),
    ],
  });
  const router = new TelegramNotificationRouter({
    store,
    taskTracker: { getTask: vi.fn(async () => task) },
    telegram: { sendMessage: vi.fn(async () => telegramMessage(9005, 105)) },
    clock: () => new Date(baseTime),
  });

  await router.scanSubscribedTasks();

  await expect(store.getActiveTaskQuestionPrompt("bot_private:105")).resolves.toMatchObject({
    taskId: "TASK-5",
    questionId: "question-1",
    status: "open",
  });
});
```

- [ ] **Step 2: Add lifecycle renderer**

In `notificationRouter.ts`, change `sendEventToSubscription` to fetch `task` once and render with task context. Add:

```ts
const renderEventNotification = (
  event: TaskEvent,
  task?: TaskRecord,
): TelegramResponse => {
  if (event.kind === "merge_request_recorded") {
    const url = typeof event.payload?.mergeRequestUrl === "string"
      ? event.payload.mergeRequestUrl
      : event.message;
    return {
      blocks: [
        { kind: "title", text: `${event.taskId}: реализация готова` },
        ...(url ? [{ kind: "paragraph" as const, text: `MR: ${url}` }] : []),
      ],
      disableWebPagePreview: true,
    };
  }
  if (
    event.kind === "task_status_changed" &&
    (event.payload as { to?: unknown } | undefined)?.to === "done"
  ) {
    return {
      blocks: [
        { kind: "title", text: `${event.taskId}: задача завершена` },
        ...(event.message ? [{ kind: "paragraph" as const, text: event.message }] : []),
      ],
      disableWebPagePreview: true,
    };
  }
  if (
    event.kind === "task_status_changed" &&
    (event.payload as { to?: unknown } | undefined)?.to === "awaiting_human"
  ) {
    const question = latestOpenQuestion(task);
    return {
      blocks: [
        { kind: "title", text: `${event.taskId}: нужен ответ` },
        { kind: "paragraph", text: question?.question.text ?? event.message ?? "Нужно уточнение." },
      ],
      disableWebPagePreview: true,
    };
  }
  return {
    blocks: [
      { kind: "title", text: `${event.taskId}: ${event.kind}` },
      ...(event.message ? [{ kind: "paragraph" as const, text: event.message }] : []),
    ],
    disableWebPagePreview: true,
  };
};
```

Add helper:

```ts
const latestOpenQuestion = (task: TaskRecord | undefined) =>
  task?.clarificationQuestions
    .filter((question) => question.status === "open")
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
    )[0];
```

- [ ] **Step 3: Store active prompt during notification**

In `sendEventToSubscription`, before sending the `awaiting_human` notification:

```ts
const openQuestion = latestOpenQuestion(task);
if (
  openQuestion &&
  event.kind === "task_status_changed" &&
  (event.payload as { to?: unknown } | undefined)?.to === "awaiting_human"
) {
  const now = this.clock().toISOString();
  await this.store.upsertActiveTaskQuestionPrompt({
    id: `telegram-question:${subscription.conversationKey}:${event.taskId}:${openQuestion.id}`,
    conversationKey: subscription.conversationKey,
    chatId: subscription.chatId,
    ...(subscription.userId !== undefined ? { userId: subscription.userId } : {}),
    taskId: event.taskId,
    questionId: openQuestion.id,
    status: "open",
    createdAt: now,
    updatedAt: now,
    expiresAt: addMilliseconds(now, 7 * 24 * 60 * 60 * 1000),
  });
}
```

- [ ] **Step 4: Add failing active prompt answer test**

In `tests/telegramAssistant.test.ts`, add:

```ts
it("records a Telegram reply to an active task question prompt", async () => {
  const taskTracker = fakeMutableTaskTrackerWithAwaitingHumanTask();
  const store = new InMemoryTelegramAssistantStore();
  await store.upsertActiveTaskQuestionPrompt({
    id: "telegram-question:bot_private:1:task_awaiting:question_latest",
    conversationKey: "bot_private:1",
    chatId: 1,
    userId: 10,
    taskId: "task_awaiting",
    questionId: "question_latest",
    status: "open",
    createdAt: baseTime,
    updatedAt: baseTime,
    expiresAt: "2026-05-31T08:00:00.000Z",
  });
  const service = buildAssistant({ store, taskTracker });

  await service.handleUpdate(messageUpdate("Выбираем вариант А", {
    updateId: 77,
    messageId: 177,
  }));

  expect(taskTracker.recordHumanAnswer).toHaveBeenCalledWith(
    "task_awaiting",
    expect.objectContaining({
      questionId: "question_latest",
      body: "Выбираем вариант А",
      command: { type: "resume", rawText: "Выбираем вариант А" },
    }),
  );
  await expect(store.getActiveTaskQuestionPrompt("bot_private:1")).resolves.toBeUndefined();
});
```

- [ ] **Step 5: Handle active prompt before generic intent routing**

In `handleMessageUnderConversationLock`, after active draft session handling and before `routeTelegramIntent`, add:

```ts
const activeQuestionPrompt = await this.store.getActiveTaskQuestionPrompt(
  message.conversationKey,
);
if (activeQuestionPrompt && message.text) {
  await this.handleActiveTaskQuestionReply(message, activeQuestionPrompt);
  return undefined;
}
```

Add helper:

```ts
private async handleActiveTaskQuestionReply(
  message: TelegramInboundMessage,
  prompt: TelegramActiveTaskQuestionPrompt,
): Promise<void> {
  if (!this.taskTracker) {
    await this.sendPlainMessage(message, TASK_ANSWER_UNAVAILABLE_MESSAGE);
    return;
  }
  const consumed = await this.store.consumeActiveTaskQuestionPrompt({
    conversationKey: message.conversationKey,
    chatId: message.chatId,
    ...(message.userId !== undefined ? { userId: message.userId } : {}),
  });
  if (!consumed) {
    await this.sendPlainMessage(message, ANSWER_QUESTION_NOT_FOUND_MESSAGE);
    return;
  }
  const body = message.text?.trim() ?? "";
  if (this.config.confirmWriteActions) {
    await this.createAnswerAiQuestionPendingAction(message, {
      taskId: prompt.taskId,
      questionId: prompt.questionId,
      body,
      command: { type: "resume", rawText: body },
    });
    return;
  }
  await this.taskTracker.recordHumanAnswer(prompt.taskId, {
    questionId: prompt.questionId,
    author: buildTelegramHumanAnswerAuthor(message, message.userId),
    body,
    command: { type: "resume", rawText: body },
  });
  await this.sendPlainMessage(message, ANSWER_RECORDED_MESSAGE);
}
```

If `confirmWriteActions` is true, use a small helper extracted from `handleAnswerAiQuestion` to create the existing answer confirmation pending action.

- [ ] **Step 6: Run notification and assistant tests**

Run:

```bash
npx vitest run tests/telegramNotifications.test.ts tests/telegramAssistant.test.ts
npm run typecheck
```

Expected: pass.

---

### Task 7: Add Owner Approval for High-Risk and Business Intake

**Files:**
- Modify: `src/domain/telegramAssistant/service.ts`
- Test: `tests/telegramAssistant.test.ts`
- Test: `tests/telegramProfileAutomation.test.ts`

- [ ] **Step 1: Add high-risk owner approval test**

Add to `tests/telegramAssistant.test.ts`:

```ts
it("requires owner approval before queueing high-risk trusted private tasks", async () => {
  const sendMessage = vi.fn();
  const taskTracker = fakeTaskTracker(taskFixture());
  const store = new InMemoryTelegramAssistantStore();
  const service = buildAssistant({
    store,
    taskTracker,
    sendMessage,
    config: {
      ...baseTelegramAssistantConfig(),
      adminUserIds: ["99"],
      profileAutomation: {
        ...baseTelegramAssistantConfig().profileAutomation,
        allowedOwnerIds: ["99"],
      },
    },
  });

  await service.handleUpdate(messageUpdate("создай задачу поменять авторизацию", {
    updateId: 90,
    messageId: 190,
  }));
  await service.handleUpdate(messageUpdate("да", {
    updateId: 91,
    messageId: 191,
  }));

  expect(taskTracker.createTask).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    chatId: "99",
    text: expect.stringContaining("High-risk"),
  }));
});
```

- [ ] **Step 2: Add business owner approval executable field test**

Update existing business test `"routes business write actions to the owner for approval before creating tasks"` to assert:

```ts
expect(createTask.mock.calls[0]?.[0]).toMatchObject({
  repositoryName: "developer",
  repoPathKey: "developer",
  baseBranch: "main",
  queue: "DEV",
  tags: expect.arrayContaining(["telegram"]),
});
```

Also assert `markReady` is called only after owner confirmation when execution is approved.

- [ ] **Step 3: Route high-risk confirmation to owner/admin**

In `completeCreateTaskAction`, before `findOrCreateTaskFromPendingAction`, parse payload and if `executionMode === "owner_approval"` and current message user is not an owner/admin, create a new pending action in owner chat:

```ts
if (payload.executionMode === "owner_approval" && !this.isOwnerOrAdmin(message.userId)) {
  await this.createOwnerApprovalPendingAction(message, executableAction, payload);
  await this.store.completePendingAction(executableAction.id, { status: "completed" });
  await this.sendPlainMessage(message, "Задача отправлена owner/admin на подтверждение запуска.");
  return;
}
```

Add helper:

```ts
private isOwnerOrAdmin(userId: number | undefined): boolean {
  if (userId === undefined) {
    return false;
  }
  const role = resolveTelegramRole(this.config, userId);
  return role === "admin" || this.config.profileAutomation.allowedOwnerIds.includes(String(userId));
}
```

- [ ] **Step 4: Implement owner approval pending action**

Owner approval action should reuse `intent.name = "create_task_draft"` and payload from original action, but `chatId/userId/conversationKey` must point to owner/admin private chat. Use the existing business owner approval pattern from `handleBusinessCreateTaskDraftForOwnerApproval`.

The approval card must include three actions if callback size allows:

```ts
[
  { text: "Создать и запустить", callback_data: `c:${ownerActionId}` },
  { text: "Создать как triage", callback_data: `confirm:create_task_triage:${ownerActionId}` },
  { text: "Отмена", callback_data: `cancel:${ownerActionId}` },
]
```

If adding `create_task_triage` callback in this task is too large, keep only "Создать и запустить" and "Отмена"; add triage action in the next task.

- [ ] **Step 5: Update business create path to use executable drafts**

In `handleBusinessCreateTaskDraftForOwnerApproval`, replace `buildHeuristicTaskDraft` with resolver + executable draft:

```ts
const repositoryResolution = resolveTelegramExecutionRepositoryProfile({
  text,
  repositories: this.repositories,
  defaultRepository: this.config.defaultRepository,
});
const selectedProfile = repositoryResolution.status === "selected"
  ? repositoryResolution.profile
  : undefined;
const draft = buildTelegramExecutableTaskDraft({
  text,
  selectedProfile,
  forceOwnerApproval: true,
});
```

If repository resolution is `needs_selection`, owner approval card should ask owner to choose repository before final approval. For this task, it is acceptable to send owner a clear message and create no task until owner replies with the repository name.

- [ ] **Step 6: Run owner approval tests**

Run:

```bash
npx vitest run tests/telegramAssistant.test.ts tests/telegramProfileAutomation.test.ts
npm run typecheck
```

Expected: pass.

---

### Task 8: Add Explicit Digital Twin Task Proposal Boundary

**Files:**
- Modify: `src/domain/telegramAssistant/service.ts`
- Modify: `src/domain/telegramAssistant/assistantCodex.ts` only if a typed proposal output is needed
- Test: `tests/telegramProfileAutomation.test.ts`

- [ ] **Step 1: Add failing TWIN proposal test**

Add to `tests/telegramProfileAutomation.test.ts`:

```ts
it("routes explicit Digital Twin task requests to owner approval instead of answer-only turn", async () => {
  const answerAsDigitalTwin = vi.fn(async () => ({
    answer: "Ок, отвечаю как Twin.",
    threadId: "thread-dt-1",
  }));
  const createTask = vi.fn(async (_input: CreateTaskInput): Promise<TaskRecord> =>
    taskFixture(),
  );
  const sendMessage = vi.fn(async () => telegramMessage(9001));
  const store = new InMemoryTelegramAssistantStore();
  await upsertBusinessConnection(store, { ownerChatId: "99" });
  const service = buildAssistant({
    store,
    taskTracker: {
      createTask,
      findTaskByExternalRef: vi.fn(async () => null),
      markReady: vi.fn(async () => undefined),
      getTask: vi.fn(async () => taskFixture()),
    } as unknown as TaskTrackerClient,
    assistantCodex: { answerAsDigitalTwin },
    sendMessage,
    config: profileAutomationConfig({
      enabled: true,
      autoReplyEnabled: true,
      requireOwnerApproval: true,
      allowedOwnerIds: ["10"],
      allowedChatIds: ["777"],
      digitalTwin: {
        ...baseTelegramAssistantConfig().digitalTwin,
        enabled: true,
        autoReplyEnabled: true,
      },
    }),
  });

  await service.handleUpdate(businessMessageUpdate({
    updateId: 300,
    messageId: 30,
    chatId: 777,
    text: "создай задачу добавить отчет по оплатам",
  }));

  expect(answerAsDigitalTwin).not.toHaveBeenCalled();
  expect(createTask).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    chatId: "99",
    text: expect.stringContaining("Создать задачу"),
  }));
});
```

- [ ] **Step 2: Change business routing order**

In `handleBusinessMessageUnderPolicy`, move explicit `intent.name === "create_task_draft"` handling before the Digital Twin auto-reply branch:

```ts
if (intent.name === "create_task_draft") {
  if (this.config.profileAutomation.requireOwnerApproval) {
    await this.handleBusinessCreateTaskDraftForOwnerApproval(
      message,
      connection,
      intent,
      intent.rawText ?? message.text ?? "",
    );
  } else if (policy.shouldAutoReply && !policy.canReply) {
    await this.notifyOwnerBusinessReplyUnavailable(connection, message);
  }
  return undefined;
}

if (
  message.source === "business" &&
  this.config.digitalTwin.enabled &&
  this.config.digitalTwin.autoReplyEnabled &&
  policy.shouldAutoReply &&
  policy.canReply &&
  this.assistantCodex?.answerAsDigitalTwin
) {
  return this.prepareDigitalTwinTurn(message, connection, options);
}
```

- [ ] **Step 3: Keep non-task Twin conversation unchanged**

Run existing Digital Twin tests:

```bash
npx vitest run tests/telegramProfileAutomation.test.ts
```

Expected: all previous Digital Twin auto-reply tests still pass except the explicit task request now goes to owner approval.

- [ ] **Step 4: Run focused suite**

Run:

```bash
npx vitest run tests/telegramProfileAutomation.test.ts tests/telegramAssistant.test.ts
npm run typecheck
```

Expected: pass.

---

### Task 9: Documentation and Operational Guardrails

**Files:**
- Modify: `docs/TELEGRAM_TASK_INTAKE.md` if it exists
- Modify: `README.md`
- Modify: `docs/ENV_CONFIGURATION.md`
- Modify: `docs/OBSERVABILITY_RUNBOOK.md`
- Test: documentation command checks

- [ ] **Step 1: Update operator docs**

If `docs/TELEGRAM_TASK_INTAKE.md` exists, update its "Current status" section to:

```md
Executable Telegram intake is implemented for trusted private users and
owner-approved Business/TWIN proposals. A confirmed low/medium-risk trusted
private task can be created with `repositoryName`, `repoPathKey`, `baseBranch`
and `queue`, then moved to `ready` for `InternalWorkerOrchestrator` claim.
High-risk and external Business/TWIN requests require owner/admin approval.
```

If the file does not exist, add the same paragraph to the Telegram Assistant
section in `README.md`.

- [ ] **Step 2: Document config behavior**

In `docs/ENV_CONFIGURATION.md`, update Telegram variables:

```md
`TELEGRAM_TASK_CREATION_ENABLED=false` blocks executable draft sessions, pending
create-task actions and direct task writes.

`TELEGRAM_CONFIRM_WRITE_ACTIONS=true` requires confirmation before task creation,
ready transitions and Telegram-recorded AI question answers.
```

- [ ] **Step 3: Document event notifications**

In `docs/OBSERVABILITY_RUNBOOK.md`, document:

```md
Telegram task subscriptions receive lifecycle notifications for queued, claimed,
awaiting human answer, MR ready, failed and done/accepted events. Notification
payloads are redacted and should not contain raw validation logs or secrets.
```

- [ ] **Step 4: Check docs diff**

Run:

```bash
git diff --check -- README.md docs
```

Expected: no whitespace errors. CRLF warnings are acceptable in this repository.

---

### Task 10: Final Verification

**Files:**
- No source changes beyond previous tasks

- [ ] **Step 1: Run focused Telegram and queue tests**

Run:

```bash
npx vitest run tests/telegramExecutableTaskDraft.test.ts tests/telegramStore.test.ts tests/telegramPostgresStore.test.ts tests/telegramAssistant.test.ts tests/telegramProfileAutomation.test.ts tests/telegramNotifications.test.ts tests/taskTrackerQueue.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: `tsc --noEmit -p tsconfig.json` exits 0.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm test
```

Expected: Vitest exits 0. If PostgreSQL integration tests are skipped because `TEST_DATABASE_URL` is not set, note that in the final report.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: production TypeScript build exits 0.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only files from this plan are modified. If unrelated files are already dirty, do not revert them; report them separately.

- [ ] **Step 6: Commit**

Commit in logical chunks if implementation was done across phases:

```bash
git add src/domain/telegramAssistant src/integrations/internalTracker/migrations tests docs README.md
git commit -m "Add Telegram executable task intake"
```

Expected: commit succeeds after tests pass.
