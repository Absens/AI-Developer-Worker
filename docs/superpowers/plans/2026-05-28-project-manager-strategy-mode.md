# Project Manager Strategy Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, read-only Project Manager `strategy` mode that identifies product and technical opportunities, stores strategy metadata, and materializes only policy-approved proposed goals through the existing goal approval path.

**Architecture:** Extend the existing PM analysis/replan domain instead of creating a separate strategy aggregate. Add a strict `PROJECT_STRATEGY` prompt/parser/policy contract, collect a bounded `ProjectStrategySnapshot`, persist strategy fields on `ProjectAnalysis`, store `mode` on every `ProjectManagerRun`, expose strategy through the existing `/api/project-manager/runs` envelope plus a read endpoint, and add minimal Angular controls/rendering. Strategy opportunities remain advisory; only `proposedGoals` with valid `sourceOpportunityId` become normal proposed `ProjectGoal` records.

**Tech Stack:** TypeScript ES modules, Node.js domain services, Codex runner, in-memory and PostgreSQL PM stores, internal task tracker, observability human API, Angular standalone components, PrimeNG, Vitest, Karma/Jasmine, Playwright.

---

## Source Spec

- `docs/superpowers/specs/2026-05-28-project-manager-product-technical-strategy-mode-design.md`

## Current Baseline

- PM `analysis` and `replan` are implemented.
- Existing PM domain files live under `src/domain/projectManager/`.
- Current markers are `PROJECT_ANALYSIS:` and `PROJECT_REPLAN:` in `src/domain/projectManager/types.ts`.
- Current `ProjectAnalysis` lacks `analysisKind` and strategy metadata.
- Current `ProjectManagerRun` lacks `mode`; metrics carry a mode label, but the stored run does not.
- Current API runner dependency only exposes `runAnalysisOnce` and `runReplanOnce`.
- Current `/api/project-manager/runs` supports `mode` defaulting to `analysis`, plus explicit `replan`.
- Current Angular PM UI can run analysis from goals and replan from goal detail.

## Subagent Dependency Graph

Use one coordinator agent to merge and review between tasks. Do not let two subagents edit the same file at the same time.

- Task 1 is foundational and must land first.
- After Task 1 lands, Task 2 and Task 3 can run in parallel.
- Task 4 depends on Tasks 1, 2, and 3.
- Task 5 depends on Task 4.
- Task 6 depends on Task 5.
- Task 7 depends on Task 6.
- Task 8 can start after Task 5 for API mock work, but the final Playwright flow depends on Task 7.
- Task 9 is final verification and review.

Recommended subagent split:

- Subagent A: Task 1 contract, parser, policy, prompt foundations.
- Subagent B: Task 2 storage and migrations.
- Subagent C: Task 3 strategy snapshot builder.
- Subagent D: Task 4 orchestrator.
- Subagent E: Task 5 API and app wiring.
- Subagent F: Task 6 Angular service/model integration and Task 7 UI rendering.
- Subagent G: Task 8 Playwright and final regression coverage.
- Coordinator: resolve conflicts, run focused tests after every merge, own Task 9.

## File Map

Domain:

- Modify `src/domain/projectManager/types.ts`: add mode/kind unions, strategy marker, strategy output types, run mode, analysis kind, strategy metadata fields.
- Modify `src/domain/projectManager/analysisParser.ts`: add `parseProjectStrategyResponse` and strategy-specific parser helpers.
- Modify `src/domain/projectManager/analysisPolicy.ts`: add strategy policy validation, evidence overlap rules, and reusable evidence identity helpers.
- Modify `src/domain/projectManager/promptBuilder.ts`: add prompt hardening for existing modes and `buildProjectStrategyPrompt`.
- Create `src/domain/projectManager/strategySnapshot.ts`: collect compact strategy inputs from task signals, analyses, goals, linked tasks, proposal metadata, repository profile, and optional brief.
- Modify `src/domain/projectManager/orchestrator.ts`: add `runStrategyOnce`, start runs with mode, record strategy analysis, strip strategy-only fields before goal creation.
- Modify `src/domain/projectManager/store.ts`: require run mode, persist analysis kind and strategy metadata in memory.
- Modify `src/domain/projectManager/index.ts`: export `strategySnapshot.ts` through the existing wildcard export pattern.

PostgreSQL:

- Create `src/integrations/internalTracker/migrations/0009_project_manager_strategy.sql`: add run mode, analysis kind, and strategy JSONB columns.
- Modify `src/integrations/internalTracker/postgresProjectManagerStore.ts`: map and persist run mode plus analysis strategy fields.
- Modify tests in `tests/projectManagerPostgresStore.test.ts`: cover migration SQL and row mapping.

API and app wiring:

- Modify `src/app.ts`: add `runStrategyOnce` to project manager dependencies and pass repository profile data.
- Modify `src/observability/taskTrackerHumanApi.ts`: extend runner type, support `mode: "strategy"`, validate `strategyBrief`, add `GET /api/project-manager/analyses`.
- Modify `tests/humanTaskApi.test.ts`: strategy run permissions, brief validation, read endpoint permissions.

Angular:

- Modify `web/src/app/models/human-api.dto.ts`: add PM analysis and strategy DTOs.
- Modify `web/src/app/services/task-mappers.ts`: map PM analysis/strategy responses.
- Modify `web/src/app/services/project-goal.service.ts`: add `runStrategy` and `listAnalyses`.
- Modify `web/src/app/pages/goals-page.component.ts`: add strategy mode controls and compact latest strategy rendering.
- Modify `web/src/app/pages/workflow-pages.spec.ts` and `web/src/app/services/project-goal.service.spec.ts`.

E2E:

- Modify `web/e2e/mock-console-server.mjs`: mock strategy run and strategy analyses read endpoint.
- Modify `web/e2e/console-critical-flows.spec.ts`: cover strategy run, visible opportunities, and strategy-created goal flow.

Docs:

- Optionally modify `docs/PROJECT_MANAGER_SUBSYSTEM_ROADMAP.md` if the roadmap tracks this PM phase.

---

## Task 1: Strategy Domain Contract, Parser, Policy, And Prompt

**Subagent:** A

**Files:**

- Modify: `src/domain/projectManager/types.ts`
- Modify: `src/domain/projectManager/analysisParser.ts`
- Modify: `src/domain/projectManager/analysisPolicy.ts`
- Modify: `src/domain/projectManager/promptBuilder.ts`
- Test: `tests/projectManagerAnalysis.test.ts`
- Test: `tests/projectManagerPrompt.test.ts`

- [x] **Step 1: Add failing strategy parser tests**

Add these imports in `tests/projectManagerAnalysis.test.ts`:

```typescript
import {
  PROJECT_STRATEGY_MARKER,
  assertProjectStrategyWithinPolicy,
  parseProjectStrategyResponse,
} from "../src/domain/projectManager/index.js";
```

Add tests:

```typescript
it("parses valid PROJECT_STRATEGY output", () => {
  const parsed = parseProjectStrategyResponse(
    `${PROJECT_STRATEGY_MARKER} ${JSON.stringify({
      summary: "Strategy found one technical opportunity.",
      analysisLenses: [
        { lens: "strategy", summary: "Validation evidence is weak." },
        { lens: "risk", summary: "Keep scope tests-only first." },
      ],
      opportunities: [
        {
          opportunityId: "opp-validation",
          dimension: "technical",
          title: "Make validation evidence trustworthy",
          problemStatement: "Recent PM outputs rely on no-op validation summaries.",
          userOrBusinessImpact: "Operators cannot trust completion signals.",
          technicalImpact: "Validation confidence is overstated.",
          evidenceRefs: [
            { kind: "snapshot", ref: "projectSignals.repeatedFailures", summary: "Repeated validation failures exist." },
          ],
          confidence: 82,
          priority: "high",
          riskLevel: "medium",
          recommendedNextStep: "create_goal",
          rationale: "Direct snapshot evidence supports a bounded tests-only goal.",
          redTeamNotes: ["Avoid broad CI rewrites."],
          architectVerdict: "pursue",
        },
      ],
      proposedGoals: [
        {
          sourceOpportunityId: "opp-validation",
          title: "Improve validation evidence quality",
          problemStatement: "PM analysis can treat weak validation commands as strong evidence.",
          desiredOutcome: "PM prompts and tests distinguish weak validation evidence from real checks.",
          successMetrics: ["Prompt tests cover no-op validation commands."],
          evidenceRefs: [
            { kind: "snapshot", ref: "projectSignals.repeatedFailures", summary: "Repeated validation failures exist." },
          ],
          priority: "high",
          riskLevel: "medium",
          suggestedTaskProposals: [
            {
              title: "Add PM validation evidence tests",
              description: "Cover no-op validation command handling in PM prompt tests.",
              taskType: "tests_only",
              acceptanceCriteria: ["Tests fail before prompt hardening and pass after it."],
              expectedBlastRadius: "Prompt tests only.",
              evidenceRefs: [
                { kind: "snapshot", ref: "projectSignals.repeatedFailures", summary: "Repeated validation failures exist." },
              ],
            },
          ],
        },
      ],
      questionsForHuman: [
        {
          question: "Which user workflow should strategy mode optimize first?",
          whyItMatters: "The snapshot has weak product context.",
          relatedOpportunityId: "opp-validation",
          relatedOpportunityTitle: "Make validation evidence trustworthy",
        },
      ],
    })}`,
  );

  expect(parsed).toMatchObject({
    summary: "Strategy found one technical opportunity.",
    opportunities: [
      {
        opportunityId: "opp-validation",
        architectVerdict: "pursue",
        recommendedNextStep: "create_goal",
      },
    ],
    proposedGoals: [
      {
        sourceOpportunityId: "opp-validation",
        title: "Improve validation evidence quality",
      },
    ],
  });
});

it("rejects PROJECT_STRATEGY proposed goals without sourceOpportunityId", () => {
  const parsed = parseProjectStrategyResponse(
    `${PROJECT_STRATEGY_MARKER} ${JSON.stringify({
      summary: "Invalid strategy.",
      analysisLenses: [],
      opportunities: [],
      proposedGoals: [
        {
          title: "Missing source opportunity",
          problemStatement: "No link.",
          desiredOutcome: "Rejected.",
          successMetrics: ["Rejected."],
          evidenceRefs: [{ kind: "snapshot", ref: "x", summary: "x" }],
          priority: "normal",
          riskLevel: "low",
          suggestedTaskProposals: [],
        },
      ],
      questionsForHuman: [],
    })}`,
  );

  expect(parsed).toBeUndefined();
});
```

- [x] **Step 2: Add failing strategy policy tests**

Add to `tests/projectManagerAnalysis.test.ts`:

```typescript
it("rejects low-confidence create_goal opportunities", () => {
  const parsed = parseProjectStrategyResponse(
    `${PROJECT_STRATEGY_MARKER} ${JSON.stringify({
      summary: "Low confidence strategy.",
      analysisLenses: [],
      opportunities: [
        {
          opportunityId: "opp-low",
          dimension: "technical",
          title: "Low confidence",
          problemStatement: "Weak evidence.",
          userOrBusinessImpact: "Unknown.",
          technicalImpact: "Unknown.",
          evidenceRefs: [{ kind: "snapshot", ref: "x", summary: "x" }],
          confidence: 59,
          priority: "normal",
          riskLevel: "low",
          recommendedNextStep: "create_goal",
          rationale: "Too weak.",
          redTeamNotes: [],
          architectVerdict: "pursue",
        },
      ],
      proposedGoals: [],
      questionsForHuman: [],
    })}`,
  );

  expect(parsed).toBeDefined();
  expect(() =>
    assertProjectStrategyWithinPolicy({
      parsed: parsed!,
      config,
    }),
  ).toThrow(/confidence below 60/i);
});

it("rejects proposed strategy goals without overlapping opportunity evidence", () => {
  const parsed = parseProjectStrategyResponse(
    `${PROJECT_STRATEGY_MARKER} ${JSON.stringify({
      summary: "Evidence mismatch.",
      analysisLenses: [],
      opportunities: [
        {
          opportunityId: "opp-1",
          dimension: "technical",
          title: "Opportunity",
          problemStatement: "Problem.",
          userOrBusinessImpact: "Operator impact.",
          technicalImpact: "Technical impact.",
          evidenceRefs: [{ kind: "snapshot", ref: "projectSignals.failedTasks", summary: "Failed tasks." }],
          confidence: 80,
          priority: "high",
          riskLevel: "medium",
          recommendedNextStep: "create_goal",
          rationale: "Supported.",
          redTeamNotes: [],
          architectVerdict: "pursue",
        },
      ],
      proposedGoals: [
        {
          sourceOpportunityId: "opp-1",
          title: "Mismatched evidence goal",
          problemStatement: "Goal evidence does not overlap.",
          desiredOutcome: "Rejected.",
          successMetrics: ["Rejected."],
          evidenceRefs: [{ kind: "task", ref: "unrelated-task", summary: "Unrelated." }],
          priority: "high",
          riskLevel: "medium",
          suggestedTaskProposals: [],
        },
      ],
      questionsForHuman: [],
    })}`,
  );

  expect(parsed).toBeDefined();
  expect(() =>
    assertProjectStrategyWithinPolicy({
      parsed: parsed!,
      config,
    }),
  ).toThrow(/evidence/i);
});
```

- [x] **Step 3: Add failing prompt tests**

Add to `tests/projectManagerPrompt.test.ts`:

```typescript
it("builds a strategy prompt with fixed lens pipeline and PROJECT_STRATEGY schema", () => {
  const prompt = buildProjectStrategyPrompt({
    snapshot: {
      repositoryName: "developer",
      generatedAt: "2026-05-28T00:00:00.000Z",
      strategyBrief: "Focus on operator confidence.",
      projectSignals: {
        repositoryName: "developer",
        generatedAt: "2026-05-28T00:00:00.000Z",
        totalTasks: 0,
        statusCounts: {},
        activeLeases: 0,
        readyTasks: [],
        failedTasks: [],
        waitingForHuman: [],
        repeatedFailures: [],
        recentReviewTasks: [],
      },
      recentAnalyses: [],
      goals: [],
      proposalBacklog: { proposed: 0, approved: 0, autoApproved: 0, rejected: 0, stale: 0 },
      taskTypeSummary: { counts: {}, unknownTaskTypeCount: 0 },
      repositoryProfile: {
        tags: [],
        focusAreas: [],
        allowedProjectManagerTaskTypes: ["documentation", "tests_only"],
      },
      productContext: {
        knownUsersOrRoles: [],
        knownWorkflows: [],
        knownProductSignals: [],
        missingProductSignals: ["No explicit product telemetry configured."],
      },
    },
    maxGoalsPerRun: 2,
    maxTaskProposalsPerGoal: 1,
    allowedTaskTypes: ["documentation", "tests_only"],
    focusAreas: ["operator confidence"],
  });

  expect(prompt).toContain("Mode: project-management-strategy-only");
  expect(prompt).toContain("PROJECT_STRATEGY:");
  expect(prompt).toContain("Strategic framing");
  expect(prompt).toContain("Red Team rejection and risk reduction");
  expect(prompt).toContain("Sober Architect final decision");
  expect(prompt).toContain("Do not expose chain-of-thought");
  expect(prompt).toContain("sourceOpportunityId");
  expect(prompt).toContain("Focus on operator confidence.");
});
```

- [x] **Step 4: Run the failing tests**

Run:

```powershell
npm test -- tests/projectManagerAnalysis.test.ts tests/projectManagerPrompt.test.ts
```

Expected: TypeScript compile errors for missing strategy marker, parser, policy, and prompt builder.

- [x] **Step 5: Add strategy constants and output types**

In `src/domain/projectManager/types.ts`, add beside the existing PM constants:

```typescript
export const PROJECT_STRATEGY_MARKER = "PROJECT_STRATEGY:";

export const PROJECT_MANAGER_MODES = ["analysis", "replan", "strategy"] as const;
export type ProjectManagerMode = (typeof PROJECT_MANAGER_MODES)[number];

export const PROJECT_ANALYSIS_KINDS = ["analysis", "replan", "strategy"] as const;
export type ProjectAnalysisKind = (typeof PROJECT_ANALYSIS_KINDS)[number];

export const PROJECT_STRATEGY_LENSES = [
  "strategy",
  "reframing",
  "empathy",
  "execution",
  "risk",
  "architecture",
  "synthesis",
] as const;
export type ProjectStrategyLens = (typeof PROJECT_STRATEGY_LENSES)[number];

export const PROJECT_STRATEGY_DIMENSIONS = [
  "product",
  "technical",
  "product_technical",
] as const;
export type ProjectStrategyDimension = (typeof PROJECT_STRATEGY_DIMENSIONS)[number];

export const PROJECT_STRATEGY_NEXT_STEPS = [
  "create_goal",
  "research",
  "ask_human",
  "defer",
] as const;
export type ProjectStrategyRecommendedNextStep =
  (typeof PROJECT_STRATEGY_NEXT_STEPS)[number];

export const PROJECT_STRATEGY_ARCHITECT_VERDICTS = [
  "pursue",
  "research_first",
  "defer",
  "reject",
] as const;
export type ProjectStrategyArchitectVerdict =
  (typeof PROJECT_STRATEGY_ARCHITECT_VERDICTS)[number];

export interface ProjectStrategyLensSummary {
  lens: ProjectStrategyLens;
  summary: string;
}

export interface ProjectStrategyOpportunity {
  opportunityId: string;
  dimension: ProjectStrategyDimension;
  title: string;
  problemStatement: string;
  userOrBusinessImpact: string;
  technicalImpact: string;
  evidenceRefs: EvidenceRef[];
  confidence: number;
  priority: ProjectGoalPriority;
  riskLevel: ProjectGoalRiskLevel;
  recommendedNextStep: ProjectStrategyRecommendedNextStep;
  rationale: string;
  redTeamNotes: string[];
  architectVerdict: ProjectStrategyArchitectVerdict;
}

export interface ProjectStrategyProposedGoalDraft extends ProjectGoalDraft {
  sourceOpportunityId: string;
}

export interface ProjectStrategyQuestion {
  question: string;
  whyItMatters: string;
  relatedOpportunityId?: string;
  relatedOpportunityTitle?: string;
}

export interface ProjectStrategyGoalLink {
  sourceOpportunityId: string;
  proposedGoalTitle: string;
  evidenceRefs: EvidenceRef[];
}

export interface ParsedProjectStrategyAnalysis {
  summary: string;
  analysisLenses: ProjectStrategyLensSummary[];
  opportunities: ProjectStrategyOpportunity[];
  proposedGoals: ProjectStrategyProposedGoalDraft[];
  questionsForHuman: ProjectStrategyQuestion[];
}
```

Extend `ProjectAnalysis`:

```typescript
analysisKind: ProjectAnalysisKind;
strategyAnalysisLenses: ProjectStrategyLensSummary[];
strategyOpportunities: ProjectStrategyOpportunity[];
strategyGoalLinks: ProjectStrategyGoalLink[];
strategyQuestions: ProjectStrategyQuestion[];
strategyBrief?: string;
```

Extend `ProjectManagerRun`:

```typescript
mode: ProjectManagerMode;
```

- [x] **Step 6: Add `parseProjectStrategyResponse`**

In `src/domain/projectManager/analysisParser.ts`, import the strategy constants and types. Reuse existing helpers where possible. Add parser helpers with these exact semantics:

```typescript
const parseIntegerInRange = (
  value: unknown,
  min: number,
  max: number,
): number | undefined => {
  if (!Number.isInteger(value)) {
    return undefined;
  }
  const parsed = value as number;
  return parsed >= min && parsed <= max ? parsed : undefined;
};
```

Add strategy parsing functions:

```typescript
const parseStrategyLensSummaries = (
  value: unknown,
): ProjectStrategyLensSummary[] | undefined => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const summaries: ProjectStrategyLensSummary[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const raw = entry as Record<string, unknown>;
    const lens = raw.lens;
    const summary = nonEmptyString(raw.summary);
    if (!includesValue<ProjectStrategyLens>(PROJECT_STRATEGY_LENSES, lens) || !summary) {
      return undefined;
    }
    summaries.push({ lens, summary });
  }
  return summaries;
};
```

Implement equivalent strict parsers for:

- `ProjectStrategyOpportunity`
- `ProjectStrategyProposedGoalDraft`
- `ProjectStrategyQuestion`

Rules:

- `opportunities` defaults to `[]` only when omitted.
- `proposedGoals` defaults to `[]` only when omitted.
- `questionsForHuman` defaults to `[]` only when omitted.
- `sourceOpportunityId` is required on every strategy proposed goal.
- `confidence` must parse as an integer from 0 through 100.
- `redTeamNotes` defaults to `[]` only when omitted.

Export:

```typescript
export const parseProjectStrategyResponse = (
  message: string | undefined,
): ParsedProjectStrategyAnalysis | undefined => {
  if (!message?.startsWith(PROJECT_STRATEGY_MARKER)) {
    return undefined;
  }
  const payload = message.slice(PROJECT_STRATEGY_MARKER.length).trim();
  if (!payload.startsWith("{")) {
    return undefined;
  }
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const summary = nonEmptyString(raw.summary);
  const analysisLenses = parseStrategyLensSummaries(raw.analysisLenses);
  const opportunities = parseStrategyOpportunities(raw.opportunities);
  const proposedGoals = parseStrategyProposedGoals(raw.proposedGoals);
  const questionsForHuman = parseStrategyQuestions(raw.questionsForHuman);
  if (!summary || !analysisLenses || !opportunities || !proposedGoals || !questionsForHuman) {
    return undefined;
  }

  return {
    summary,
    analysisLenses,
    opportunities,
    proposedGoals,
    questionsForHuman,
  };
};
```

- [x] **Step 7: Add strategy policy validation**

In `src/domain/projectManager/analysisPolicy.ts`, add:

```typescript
export const PROJECT_MANAGER_STRATEGY_POLICY_LIMITS = {
  maxOpportunities: 10,
  maxQuestionsForHuman: 5,
  maxAnalysisLenses: 7,
  maxRedTeamNotesPerOpportunity: 5,
  minCreateGoalConfidence: 60,
} as const;
```

Add normalized evidence identity helpers:

```typescript
const evidenceIdentity = (ref: EvidenceRef): string =>
  `${ref.kind}:${ref.ref.trim().toLowerCase()}`;

const hasEvidenceOverlap = (
  left: readonly EvidenceRef[],
  right: readonly EvidenceRef[],
): boolean => {
  const leftIdentities = new Set(left.map(evidenceIdentity));
  return right.some((ref) => leftIdentities.has(evidenceIdentity(ref)));
};
```

Add:

```typescript
export interface AssertProjectStrategyWithinPolicyInput {
  parsed: ParsedProjectStrategyAnalysis;
  config: ProjectManagerConfig;
}
```

Implement `assertProjectStrategyWithinPolicy(input)` with these checks:

- `summary` uses the existing max summary length.
- `analysisLenses.length <= 7`.
- `opportunities.length <= 10`.
- `questionsForHuman.length <= 5`.
- Every opportunity has at least one evidence ref.
- Opportunity ids are unique and non-empty.
- Every opportunity text field is bounded by existing PM text limits.
- `redTeamNotes.length <= 5`.
- `create_goal` requires `confidence >= 60`.
- `create_goal` requires `architectVerdict === "pursue"`.
- `parsed.proposedGoals.length <= config.maxGoalsPerRun`.
- Every proposed goal has a valid `sourceOpportunityId`.
- Referenced opportunity must have `architectVerdict === "pursue"`.
- Goal evidence must overlap referenced opportunity evidence by normalized `(kind, ref)`.
- High-risk proposed goals have at most one suggested task proposal.
- High-risk proposed goals may use only `documentation` or `tests_only` task types unless `priority === "critical"` and evidence contains at least one `task`, `validation_failure`, or `review_comment`.
- Suggested task types must exist in `config.allowedTaskTypes`.

Use `validateGoal` for the `ProjectGoalDraft` part of every strategy proposed goal.

- [x] **Step 8: Add prompt hardening to existing analysis and replan prompts**

In `src/domain/projectManager/promptBuilder.ts`, add these guardrails to both `buildProjectAnalysisPrompt` and `buildProjectReplanPrompt`:

```typescript
"- Do not create goals from weak or missing evidence.",
"- If the snapshot only shows no-op validation commands, treat validation confidence as weak.",
"- Avoid duplicate goals that differ only in wording.",
"- Prefer tests-only or documentation proposals when evidence points to validation, reporting, or documentation gaps.",
"- Keep goal scope small enough for one or two task proposals.",
```

Update `tests/projectManagerPrompt.test.ts` to assert the prompt contains:

```typescript
expect(prompt).toContain("Do not create goals from weak or missing evidence.");
expect(prompt).toContain("no-op validation commands");
expect(prompt).toContain("Avoid duplicate goals");
```

- [x] **Step 9: Add `buildProjectStrategyPrompt`**

In `src/domain/projectManager/promptBuilder.ts`, add:

```typescript
export interface BuildProjectStrategyPromptInput {
  snapshot: ProjectStrategySnapshot;
  maxGoalsPerRun?: number;
  maxTaskProposalsPerGoal?: number;
  allowedTaskTypes?: TaskType[];
  focusAreas?: string[];
  maxSnapshotChars?: number;
}
```

Add a `STRATEGY_RESPONSE_SCHEMA` object matching the spec. Use `ALLOWED_EVIDENCE_REF_KINDS` for evidence kinds and `RESPONSE_SCHEMA.proposedGoals[0]` structure as the base for proposed goals, with `sourceOpportunityId`.

Implement the prompt with these required lines:

```typescript
"Mode: project-management-strategy-only",
"Analyze product and technical opportunities from the bounded strategy snapshot.",
"Use this fixed internal lens sequence:",
"1. Strategic framing",
"2. Product and technical opportunity discovery",
"3. Defamiliarizing reframing",
"4. Empathic impact check",
"5. Executive conversion to actionable goals",
"6. Red Team rejection and risk reduction",
"7. Sober Architect final decision",
"8. Synthetic JSON output",
"Do not expose chain-of-thought; return only short audit summaries in analysisLenses.",
"Raw opportunities are advisory and must not create executable work.",
"Only proposedGoals with sourceOpportunityId can be materialized as normal proposed goals.",
"If product evidence is missing, ask focused questions instead of inventing product claims.",
```

Required output line:

```typescript
`Reply with exactly one line starting with ${PROJECT_STRATEGY_MARKER} followed by compact JSON matching this schema.`
```

- [x] **Step 10: Run focused tests**

Run:

```powershell
npm test -- tests/projectManagerAnalysis.test.ts tests/projectManagerPrompt.test.ts
npm run typecheck
```

Expected: strategy parser, policy, and prompt tests pass; TypeScript compiles after dependent files are adjusted for new required fields.

- [x] **Step 11: Commit Task 1**

```powershell
git add src/domain/projectManager/types.ts src/domain/projectManager/analysisParser.ts src/domain/projectManager/analysisPolicy.ts src/domain/projectManager/promptBuilder.ts tests/projectManagerAnalysis.test.ts tests/projectManagerPrompt.test.ts
git commit -m "feat: add project manager strategy contract"
```

---

## Task 2: Run And Analysis Storage Schema

**Subagent:** B

**Files:**

- Modify: `src/domain/projectManager/store.ts`
- Create: `src/integrations/internalTracker/migrations/0009_project_manager_strategy.sql`
- Modify: `src/integrations/internalTracker/postgresProjectManagerStore.ts`
- Test: `tests/projectManagerGoalStore.test.ts`
- Test: `tests/projectManagerPostgresStore.test.ts`

- [x] **Step 1: Add failing in-memory store tests**

In `tests/projectManagerGoalStore.test.ts`, add:

```typescript
it("stores run mode for completed and failed project manager runs", async () => {
  const store = new InMemoryProjectManagerStore({ now: clock.now });

  const started = await store.startRun({
    repositoryName: "developer",
    trigger: "manual",
    mode: "strategy",
  });
  expect(started.mode).toBe("strategy");

  const failed = await store.failRun(started.id, "bad strategy output");
  expect(failed).toMatchObject({
    id: started.id,
    mode: "strategy",
    status: "failed",
    diagnostic: "bad strategy output",
  });
});

it("stores strategy analysis metadata without changing goal storage shape", async () => {
  const store = new InMemoryProjectManagerStore({ now: clock.now });

  const analysis = await store.recordAnalysis({
    repositoryName: "developer",
    analysisKind: "strategy",
    summary: "Strategy summary.",
    healthSignals: [],
    proposedGoals: [goalDraft({ title: "Strategy-created goal" })],
    staleGoalIds: [],
    goalReplans: [],
    strategyBrief: "Focus on validation trust.",
    strategyAnalysisLenses: [{ lens: "strategy", summary: "Validation trust matters." }],
    strategyOpportunities: [
      {
        opportunityId: "opp-1",
        dimension: "technical",
        title: "Validation trust",
        problemStatement: "Weak validation evidence.",
        userOrBusinessImpact: "Operators lose confidence.",
        technicalImpact: "Quality signals are unreliable.",
        evidenceRefs: [{ kind: "snapshot", ref: "projectSignals.failedTasks", summary: "Failures exist." }],
        confidence: 80,
        priority: "high",
        riskLevel: "medium",
        recommendedNextStep: "create_goal",
        rationale: "Evidence supports it.",
        redTeamNotes: ["Keep scope narrow."],
        architectVerdict: "pursue",
      },
    ],
    strategyGoalLinks: [
      {
        sourceOpportunityId: "opp-1",
        proposedGoalTitle: "Strategy-created goal",
        evidenceRefs: [{ kind: "snapshot", ref: "projectSignals.failedTasks", summary: "Failures exist." }],
      },
    ],
    strategyQuestions: [],
  });

  expect(analysis).toMatchObject({
    analysisKind: "strategy",
    strategyBrief: "Focus on validation trust.",
    strategyOpportunities: [expect.objectContaining({ opportunityId: "opp-1" })],
    strategyGoalLinks: [expect.objectContaining({ sourceOpportunityId: "opp-1" })],
  });

  const [goal] = await store.createGoalsFromAnalysis({
    repositoryName: "developer",
    sourceAnalysisId: analysis.id,
    goals: analysis.proposedGoals,
  });
  expect(goal).not.toHaveProperty("sourceOpportunityId");
});
```

- [x] **Step 2: Add failing PostgreSQL tests**

In `tests/projectManagerPostgresStore.test.ts`, add in the store test suite:

```typescript
it("persists strategy run mode and analysis metadata", async () => {
  const { store } = createStoreWithMemoryDb();

  const run = await store.startRun({
    repositoryName: "developer",
    trigger: "manual",
    mode: "strategy",
  });
  expect(run.mode).toBe("strategy");

  const analysis = await store.recordAnalysis({
    repositoryName: "developer",
    analysisKind: "strategy",
    summary: "Strategy summary.",
    healthSignals: [],
    proposedGoals: [],
    staleGoalIds: [],
    goalReplans: [],
    strategyAnalysisLenses: [{ lens: "risk", summary: "Limit fan-out." }],
    strategyOpportunities: [],
    strategyGoalLinks: [],
    strategyQuestions: [
      { question: "Which workflow matters most?", whyItMatters: "Product context is missing." },
    ],
    strategyBrief: "Focus on operator confidence.",
  });

  const analyses = await store.listAnalyses();
  expect(analyses.find((candidate) => candidate.id === analysis.id)).toMatchObject({
    analysisKind: "strategy",
    strategyBrief: "Focus on operator confidence.",
    strategyQuestions: [expect.objectContaining({ question: "Which workflow matters most?" })],
  });
});
```

Add a migration test:

```typescript
it("includes a migration for project manager strategy persistence", () => {
  const migration = listInternalTrackerMigrations().find(
    (candidate) => candidate.filename === "0009_project_manager_strategy.sql",
  );

  expect(migration?.sql).toContain("ADD COLUMN IF NOT EXISTS mode text");
  expect(migration?.sql).toContain("ADD COLUMN IF NOT EXISTS analysis_kind text");
  expect(migration?.sql).toContain("strategy_opportunities jsonb");
  expect(migration?.sql).toContain("project_manager_runs_mode_check");
  expect(migration?.sql).toContain("project_analyses_analysis_kind_check");
});
```

- [x] **Step 3: Run failing storage tests**

Run:

```powershell
npm test -- tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts
```

Expected: compile failures for `mode`, `analysisKind`, and strategy fields.

- [x] **Step 4: Update in-memory store contracts**

In `src/domain/projectManager/store.ts`, change:

```typescript
export interface StartProjectManagerRunInput {
  repositoryName: string;
  trigger: ProjectManagerTrigger;
  mode: ProjectManagerMode;
}
```

Change `RecordProjectAnalysisInput` to include:

```typescript
analysisKind: ProjectAnalysisKind;
strategyAnalysisLenses?: ProjectStrategyLensSummary[];
strategyOpportunities?: ProjectStrategyOpportunity[];
strategyGoalLinks?: ProjectStrategyGoalLink[];
strategyQuestions?: ProjectStrategyQuestion[];
strategyBrief?: string;
```

In `startRun`, set:

```typescript
mode: input.mode,
```

In `recordAnalysis`, set:

```typescript
analysisKind: input.analysisKind,
strategyAnalysisLenses: structuredClone(input.strategyAnalysisLenses ?? []),
strategyOpportunities: structuredClone(input.strategyOpportunities ?? []),
strategyGoalLinks: structuredClone(input.strategyGoalLinks ?? []),
strategyQuestions: structuredClone(input.strategyQuestions ?? []),
...(input.strategyBrief ? { strategyBrief: input.strategyBrief } : {}),
```

- [x] **Step 5: Add PostgreSQL migration**

Create `src/integrations/internalTracker/migrations/0009_project_manager_strategy.sql`:

```sql
ALTER TABLE project_manager_runs
  ADD COLUMN IF NOT EXISTS mode text;

UPDATE project_manager_runs
SET mode = 'analysis'
WHERE mode IS NULL;

ALTER TABLE project_manager_runs
  ALTER COLUMN mode SET NOT NULL;

ALTER TABLE project_manager_runs
  DROP CONSTRAINT IF EXISTS project_manager_runs_mode_check,
  ADD CONSTRAINT project_manager_runs_mode_check
  CHECK (mode IN ('analysis', 'replan', 'strategy'));

ALTER TABLE project_analyses
  ADD COLUMN IF NOT EXISTS analysis_kind text,
  ADD COLUMN IF NOT EXISTS strategy_analysis_lenses jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_opportunities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_goal_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_brief text;

UPDATE project_analyses
SET analysis_kind = CASE
  WHEN replan_reason IS NOT NULL THEN 'replan'
  ELSE 'analysis'
END
WHERE analysis_kind IS NULL;

ALTER TABLE project_analyses
  ALTER COLUMN analysis_kind SET NOT NULL;

ALTER TABLE project_analyses
  DROP CONSTRAINT IF EXISTS project_analyses_analysis_kind_check,
  ADD CONSTRAINT project_analyses_analysis_kind_check
  CHECK (analysis_kind IN ('analysis', 'replan', 'strategy'));

CREATE INDEX IF NOT EXISTS project_analyses_repository_kind_time_idx
  ON project_analyses(repository_name, analysis_kind, created_at DESC, id);
```

Add `project_analyses_repository_kind_time_idx` to `REQUIRED_INTERNAL_TRACKER_INDEXES` in `src/integrations/internalTracker/migrations.ts`.

- [x] **Step 6: Update PostgreSQL row mapping**

In `src/integrations/internalTracker/postgresProjectManagerStore.ts`:

- Add `mode` to `ProjectManagerRunRow`.
- Add strategy columns and `analysis_kind` to the analysis row type.
- Update `mapRunRow` with `mode: row.mode`.
- Update `mapAnalysisRow` with:

```typescript
analysisKind: row.analysis_kind,
strategyAnalysisLenses: jsonValue(row.strategy_analysis_lenses, []),
strategyOpportunities: jsonValue(row.strategy_opportunities, []),
strategyGoalLinks: jsonValue(row.strategy_goal_links, []),
strategyQuestions: jsonValue(row.strategy_questions, []),
...(row.strategy_brief ? { strategyBrief: row.strategy_brief } : {}),
```

Update `startRun` SQL to insert `mode`.

Update `recordAnalysis` SQL to insert:

```sql
analysis_kind,
strategy_analysis_lenses,
strategy_opportunities,
strategy_goal_links,
strategy_questions,
strategy_brief
```

Bind JSON values using `JSON.stringify(input.strategyAnalysisLenses ?? [])` and the same pattern for other strategy arrays.

- [x] **Step 7: Update existing callers and tests for required `mode` and `analysisKind`**

Change existing orchestrator calls:

```typescript
await this.store.startRun({
  repositoryName: input.repositoryName,
  trigger,
  mode: "analysis",
});
```

and:

```typescript
await this.store.startRun({
  repositoryName: input.repositoryName,
  trigger,
  mode: "replan",
});
```

Change existing `recordAnalysis` calls:

```typescript
analysisKind: "analysis",
```

and:

```typescript
analysisKind: "replan",
```

Update test helper calls in PM tests to include `mode` when calling `startRun` directly and `analysisKind` when calling `recordAnalysis` directly.

- [x] **Step 8: Run storage tests**

Run:

```powershell
npm test -- tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts tests/projectManagerOrchestrator.test.ts
npm run typecheck
```

Expected: storage tests pass; orchestrator tests pass after mode/kind updates.

- [x] **Step 9: Commit Task 2**

```powershell
git add src/domain/projectManager/store.ts src/domain/projectManager/orchestrator.ts src/integrations/internalTracker/migrations.ts src/integrations/internalTracker/migrations/0009_project_manager_strategy.sql src/integrations/internalTracker/postgresProjectManagerStore.ts tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts tests/projectManagerOrchestrator.test.ts
git commit -m "feat: persist project manager strategy metadata"
```

---

## Task 3: Strategy Snapshot Builder

**Subagent:** C

**Files:**

- Create: `src/domain/projectManager/strategySnapshot.ts`
- Modify: `src/domain/projectManager/index.ts`
- Test: `tests/projectManagerSignals.test.ts`

- [x] **Step 1: Add failing snapshot tests**

In `tests/projectManagerSignals.test.ts`, import:

```typescript
import { collectProjectStrategySnapshot } from "../src/domain/projectManager/index.js";
```

Add:

```typescript
it("collects compact strategy inputs from signals, analyses, goals, proposals, and repository profile", async () => {
  const tracker = trackerWithTasks([
    taskRecord({
      id: "task-review",
      title: "Review curator workflow",
      status: "review",
      repositoryName: "developer",
      taskType: "tests_only",
      qualityGateRuns: [
        {
          id: "qg-1",
          taskId: "task-review",
          status: "failed",
          summary: "Validation failed.",
          createdAt: "2026-05-28T00:00:00.000Z",
        },
      ],
    }),
    taskRecord({
      id: "task-proposal",
      title: "Proposed PM task",
      status: "triage",
      repositoryName: "developer",
      taskType: "unknown",
      proposal: {
        id: "proposal-1",
        taskId: "task-proposal",
        supervisorStatus: "proposed",
        autonomyLevel: "proposal_only",
        createdAt: "2026-05-28T00:00:00.000Z",
        updatedAt: "2026-05-28T00:00:00.000Z",
        policyEvaluation: {
          id: "policy-1",
          taskId: "task-proposal",
          decision: "allow",
          reason: "Allowed.",
          createdAt: "2026-05-28T00:00:00.000Z",
        },
        policyEvaluations: [],
      },
    }),
  ]);
  const store = new InMemoryProjectManagerStore({
    now: () => new Date("2026-05-28T00:00:00.000Z"),
  });
  const analysis = await store.recordAnalysis({
    repositoryName: "developer",
    analysisKind: "analysis",
    summary: "Previous analysis summary.",
    healthSignals: [],
    proposedGoals: [],
    staleGoalIds: [],
    goalReplans: [],
  });
  const [goal] = await store.createGoalsFromAnalysis({
    repositoryName: "developer",
    sourceAnalysisId: analysis.id,
    goals: [
      {
        title: "Improve validation trust",
        problemStatement: "Validation evidence is weak.",
        desiredOutcome: "Operators trust PM output.",
        successMetrics: ["Validation summaries include real commands."],
        evidenceRefs: [{ kind: "snapshot", ref: "projectSignals.failedTasks", summary: "Failures exist." }],
        priority: "high",
        riskLevel: "medium",
        suggestedTaskProposals: [],
      },
    ],
  });

  const snapshot = await collectProjectStrategySnapshot({
    taskTracker: tracker,
    store,
    repositoryName: "developer",
    strategyBrief: " Focus on validation trust. ",
    config: {
      enabled: true,
      focusAreas: ["operator confidence"],
      runOnce: false,
      intervalMinutes: 60,
      maxGoalsPerRun: 3,
      maxTaskProposalsPerGoal: 2,
      defaultAutonomyLevel: "proposal_only",
      autoApproveLowRisk: false,
      allowedTaskTypes: ["documentation", "tests_only"],
      repositoryScanEnabled: false,
      repositoryScanMaxFiles: 0,
      requireHumanGoalApproval: true,
    },
    repositoryProfile: {
      baseBranch: "main",
      queue: "default",
      tags: ["pm"],
    },
    now: () => new Date("2026-05-28T00:00:00.000Z"),
  });

  expect(snapshot).toMatchObject({
    repositoryName: "developer",
    strategyBrief: "Focus on validation trust.",
    recentAnalyses: [expect.objectContaining({ id: analysis.id, analysisKind: "analysis" })],
    proposalBacklog: expect.objectContaining({ proposed: 1 }),
    taskTypeSummary: expect.objectContaining({ unknownTaskTypeCount: 1 }),
    repositoryProfile: expect.objectContaining({
      baseBranch: "main",
      queue: "default",
      tags: ["pm"],
      focusAreas: ["operator confidence"],
      allowedProjectManagerTaskTypes: ["documentation", "tests_only"],
    }),
    productContext: expect.objectContaining({
      missingProductSignals: expect.arrayContaining(["No explicit product telemetry configured."]),
    }),
  });
  expect(snapshot.goals).toEqual([
    expect.objectContaining({
      id: goal.id,
      title: "Improve validation trust",
      linkedTaskOutcomes: [],
    }),
  ]);
});
```

- [x] **Step 2: Run failing snapshot tests**

Run:

```powershell
npm test -- tests/projectManagerSignals.test.ts
```

Expected: missing `strategySnapshot.ts` and `collectProjectStrategySnapshot`.

- [x] **Step 3: Create strategy snapshot types and collector**

Create `src/domain/projectManager/strategySnapshot.ts` with:

```typescript
import type { TaskType } from "../../models/types.js";
import type { TaskTrackerClient } from "../taskTracker/types.js";
import { collectProjectSignals } from "./signalCollector.js";
import type {
  ProjectAnalysis,
  ProjectGoal,
  ProjectManagerConfig,
  ProjectSignalSnapshot,
} from "./types.js";
import type { ProjectManagerStore } from "./store.js";

export interface ProjectStrategyRepositoryProfile {
  baseBranch?: string;
  queue?: string;
  tags: string[];
  focusAreas: string[];
  allowedProjectManagerTaskTypes: TaskType[];
}

export interface ProjectStrategySnapshot {
  repositoryName: string;
  generatedAt: string;
  strategyBrief?: string;
  projectSignals: ProjectSignalSnapshot;
  recentAnalyses: Array<{
    id: string;
    analysisKind: ProjectAnalysis["analysisKind"];
    summary: string;
    createdAt: string;
  }>;
  goals: Array<{
    id: string;
    status: ProjectGoal["status"];
    title: string;
    priority: ProjectGoal["priority"];
    riskLevel: ProjectGoal["riskLevel"];
    summary: string;
    linkedTaskOutcomes: Array<{
      taskId: string;
      status: string;
      latestValidationSummary?: string;
      failedAgentRuns: number;
      failedValidations: number;
    }>;
  }>;
  proposalBacklog: {
    proposed: number;
    approved: number;
    autoApproved: number;
    rejected: number;
    stale: number;
  };
  taskTypeSummary: {
    counts: Record<string, number>;
    unknownTaskTypeCount: number;
  };
  repositoryProfile: ProjectStrategyRepositoryProfile;
  productContext: {
    knownUsersOrRoles: string[];
    knownWorkflows: string[];
    knownProductSignals: string[];
    missingProductSignals: string[];
  };
}
```

Add:

```typescript
export interface CollectProjectStrategySnapshotInput {
  taskTracker: TaskTrackerClient;
  store: ProjectManagerStore;
  repositoryName: string;
  config: ProjectManagerConfig;
  strategyBrief?: string;
  repositoryProfile?: {
    baseBranch?: string;
    queue?: string;
    tags?: string[];
  };
  now?: () => Date;
  limit?: number;
}
```

Implement `collectProjectStrategySnapshot` using:

- `collectProjectSignals`.
- `store.listAnalyses()` filtered by repository and newest first, max 10.
- `store.listGoals({ repositoryName, status: ["proposed", "approved", "active", "completed", "rejected", "stale"] })`, newest fields are already on goals.
- `store.listGoalTaskLinks(goal.id)` and `taskTracker.getTask(link.taskId)` for linked task summaries, swallowing only `TaskNotFoundError`.
- `taskTracker.listTasks({ repositoryName, limit })` for proposal backlog and task type summary.

Proposal backlog mapping:

- `proposal.supervisorStatus === "proposed"` increments `proposed`.
- `proposal.supervisorStatus === "approved"` increments `approved`.
- `proposal.supervisorStatus === "auto_approved"` increments `autoApproved`.
- `proposal.supervisorStatus === "rejected"` increments `rejected`.
- `proposal.supervisorStatus === "proposed"` and `proposal.cleanup.staleAfter` in the past increments `stale`.

Use this brief helper:

```typescript
const trimStrategyBrief = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 2000) : undefined;
};
```

Use this product context for the first slice:

```typescript
productContext: {
  knownUsersOrRoles: [],
  knownWorkflows: [],
  knownProductSignals: [],
  missingProductSignals: ["No explicit product telemetry configured."],
}
```

- [x] **Step 4: Ensure export**

`src/domain/projectManager/index.ts` already wildcard-exports known PM files. Add:

```typescript
export * from "./strategySnapshot.js";
```

- [x] **Step 5: Run snapshot tests**

Run:

```powershell
npm test -- tests/projectManagerSignals.test.ts
npm run typecheck
```

- [x] **Step 6: Commit Task 3**

```powershell
git add src/domain/projectManager/strategySnapshot.ts src/domain/projectManager/index.ts tests/projectManagerSignals.test.ts
git commit -m "feat: collect project manager strategy snapshots"
```

---

## Task 4: Strategy Orchestrator Path

**Subagent:** D

**Files:**

- Modify: `src/domain/projectManager/orchestrator.ts`
- Test: `tests/projectManagerOrchestrator.test.ts`

- [x] **Step 1: Add failing orchestrator tests**

In `tests/projectManagerOrchestrator.test.ts`, add a helper:

```typescript
const strategyResponse = (overrides: Record<string, unknown> = {}): string =>
  `${PROJECT_STRATEGY_MARKER} ${JSON.stringify({
    summary: "Strategy found a bounded improvement.",
    analysisLenses: [{ lens: "strategy", summary: "Validation trust is high leverage." }],
    opportunities: [
      {
        opportunityId: "opp-1",
        dimension: "technical",
        title: "Improve validation trust",
        problemStatement: "No-op validation can be treated as strong evidence.",
        userOrBusinessImpact: "Operators lose confidence in PM-created work.",
        technicalImpact: "Quality gates are under-specified.",
        evidenceRefs: [{ kind: "snapshot", ref: "projectSignals.failedTasks", summary: "Failed tasks exist." }],
        confidence: 80,
        priority: "high",
        riskLevel: "medium",
        recommendedNextStep: "create_goal",
        rationale: "Direct operational evidence supports a narrow goal.",
        redTeamNotes: ["Avoid broad CI rewrites."],
        architectVerdict: "pursue",
      },
    ],
    proposedGoals: [
      {
        sourceOpportunityId: "opp-1",
        title: "Improve validation trust",
        problemStatement: "No-op validation can be treated as strong evidence.",
        desiredOutcome: "PM prompts and tests distinguish weak validation evidence.",
        successMetrics: ["Prompt tests cover no-op validation commands."],
        evidenceRefs: [{ kind: "snapshot", ref: "projectSignals.failedTasks", summary: "Failed tasks exist." }],
        priority: "high",
        riskLevel: "medium",
        suggestedTaskProposals: [
          {
            title: "Add validation trust prompt tests",
            description: "Add tests for no-op validation command treatment.",
            taskType: "tests_only",
            acceptanceCriteria: ["Tests cover no-op validation evidence."],
            expectedBlastRadius: "Prompt tests only.",
            evidenceRefs: [{ kind: "snapshot", ref: "projectSignals.failedTasks", summary: "Failed tasks exist." }],
          },
        ],
      },
    ],
    questionsForHuman: [],
    ...overrides,
  })}`;
```

Add:

```typescript
it("stores a completed strategy run and materializes only proposed goals", async () => {
  const codex = new FakeCodexRunner(codexExecution(strategyResponse()));
  const store = new InMemoryProjectManagerStore({ now: fixedNow });
  const orchestrator = new ProjectManagerOrchestrator({
    taskTracker: trackerWithTasks([]),
    codex,
    store,
    config,
  });

  const result = await orchestrator.runStrategyOnce({
    repositoryName: "developer",
    strategyBrief: " Focus on validation trust. ",
  });

  expect(result.run).toMatchObject({
    status: "completed",
    mode: "strategy",
    proposedTaskIds: [],
  });
  expect(result.analysis).toMatchObject({
    analysisKind: "strategy",
    strategyBrief: "Focus on validation trust.",
    strategyOpportunities: [expect.objectContaining({ opportunityId: "opp-1" })],
    strategyGoalLinks: [expect.objectContaining({ sourceOpportunityId: "opp-1" })],
  });
  const goals = await store.listGoals({ repositoryName: "developer" });
  expect(goals).toHaveLength(1);
  expect(goals[0]).toMatchObject({
    title: "Improve validation trust",
    sourceAnalysisId: result.analysis.id,
    sourceRunId: result.run.id,
    status: "proposed",
  });
  expect(goals[0]).not.toHaveProperty("sourceOpportunityId");
  expect(codex.prompts[0]).toContain("Mode: project-management-strategy-only");
  expect(codex.prompts[0]).toContain("PROJECT_STRATEGY:");
});

it("stores failed strategy runs with mode when Codex output is invalid", async () => {
  const codex = new FakeCodexRunner(codexExecution("not strategy"));
  const store = new InMemoryProjectManagerStore({ now: fixedNow });
  const orchestrator = new ProjectManagerOrchestrator({
    taskTracker: trackerWithTasks([]),
    codex,
    store,
    config,
  });

  await expect(
    orchestrator.runStrategyOnce({ repositoryName: "developer" }),
  ).rejects.toThrow(/valid PROJECT_STRATEGY/);

  const [run] = await store.listRuns();
  expect(run).toMatchObject({
    status: "failed",
    mode: "strategy",
    diagnostic: expect.stringMatching(/valid PROJECT_STRATEGY/),
  });
});
```

- [x] **Step 2: Run failing orchestrator tests**

Run:

```powershell
npm test -- tests/projectManagerOrchestrator.test.ts
```

Expected: missing `runStrategyOnce`.

- [x] **Step 3: Add strategy run interfaces**

In `src/domain/projectManager/orchestrator.ts`, add:

```typescript
export interface RunProjectStrategyOnceInput {
  repositoryName: string;
  strategyBrief?: string;
  trigger?: ProjectManagerTrigger;
  repositoryProfile?: {
    baseBranch?: string;
    queue?: string;
    tags?: string[];
  };
}

export interface RunProjectStrategyOnceResult {
  run: ProjectManagerRun;
  analysis: ProjectAnalysis;
  strategy: {
    summary: string;
    analysisLenses: ProjectStrategyLensSummary[];
    opportunities: ProjectStrategyOpportunity[];
    goalLinks: ProjectStrategyGoalLink[];
    questionsForHuman: ProjectStrategyQuestion[];
  };
}
```

- [x] **Step 4: Add strategy brief validation helper**

In `orchestrator.ts`:

```typescript
const normalizeStrategyBrief = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 2000) {
    throw new Error("strategyBrief must be at most 2000 characters.");
  }
  return trimmed;
};
```

- [x] **Step 5: Implement `runStrategyOnce`**

Add method:

```typescript
public async runStrategyOnce(
  input: RunProjectStrategyOnceInput,
): Promise<RunProjectStrategyOnceResult> {
  if (!this.config.enabled) {
    throw new Error("Project manager is disabled.");
  }

  const strategyBrief = normalizeStrategyBrief(input.strategyBrief);
  const trigger = input.trigger ?? "manual";
  const run = await this.store.startRun({
    repositoryName: input.repositoryName,
    trigger,
    mode: "strategy",
  });

  try {
    const snapshot = await collectProjectStrategySnapshot({
      taskTracker: this.taskTracker,
      store: this.store,
      repositoryName: input.repositoryName,
      config: this.config,
      strategyBrief,
      repositoryProfile: input.repositoryProfile,
    });
    const prompt = buildProjectStrategyPrompt({
      snapshot,
      maxGoalsPerRun: this.config.maxGoalsPerRun,
      maxTaskProposalsPerGoal: this.config.maxTaskProposalsPerGoal,
      allowedTaskTypes: this.config.allowedTaskTypes,
      focusAreas: this.focusAreas,
    });
    const execution = await this.codex.runInitial(prompt, undefined, {
      sandbox: "read-only",
    });
    if (execution.process.exitCode !== 0) {
      throw new Error(
        `Codex project strategy failed with exit code ${execution.process.exitCode}.`,
      );
    }

    const parsed = parseProjectStrategyResponse(execution.finalMessage);
    if (!parsed) {
      throw new Error("Codex response must be valid PROJECT_STRATEGY output.");
    }
    assertProjectStrategyWithinPolicy({
      parsed,
      config: this.config,
    });

    const goalLinks = parsed.proposedGoals.map((goal) => ({
      sourceOpportunityId: goal.sourceOpportunityId,
      proposedGoalTitle: goal.title,
      evidenceRefs: structuredClone(goal.evidenceRefs),
    }));
    const proposedGoals = parsed.proposedGoals.map(
      ({ sourceOpportunityId: _sourceOpportunityId, ...goal }) => goal,
    );
    const analysis = await this.store.recordAnalysis({
      repositoryName: input.repositoryName,
      analysisKind: "strategy",
      summary: parsed.summary,
      healthSignals: [],
      proposedGoals,
      staleGoalIds: [],
      goalReplans: [],
      strategyAnalysisLenses: parsed.analysisLenses,
      strategyOpportunities: parsed.opportunities,
      strategyGoalLinks: goalLinks,
      strategyQuestions: parsed.questionsForHuman,
      ...(strategyBrief ? { strategyBrief } : {}),
    });
    const goals = await this.store.createGoalsFromAnalysis({
      repositoryName: input.repositoryName,
      sourceAnalysisId: analysis.id,
      sourceRunId: run.id,
      goals: analysis.proposedGoals,
    });
    const completedRun = await this.store.completeRun(run.id, {
      analysisId: analysis.id,
      proposedGoalIds: goals.map((goal) => goal.id),
      proposedTaskIds: [],
    });
    this.recordProjectManagerRunMetric(
      input.repositoryName,
      "strategy",
      trigger,
      "completed",
    );

    return {
      run: completedRun,
      analysis,
      strategy: {
        summary: analysis.summary,
        analysisLenses: analysis.strategyAnalysisLenses,
        opportunities: analysis.strategyOpportunities,
        goalLinks: analysis.strategyGoalLinks,
        questionsForHuman: analysis.strategyQuestions,
      },
    };
  } catch (error) {
    await this.store.failRun(run.id, diagnosticFor(error));
    this.recordProjectManagerRunMetric(
      input.repositoryName,
      "strategy",
      trigger,
      "failed",
    );
    throw error;
  }
}
```

- [x] **Step 6: Widen metric mode type**

Change:

```typescript
mode: "analysis" | "replan",
```

to:

```typescript
mode: ProjectManagerMode,
```

in `recordProjectManagerRunMetric`.

- [x] **Step 7: Run orchestrator tests**

Run:

```powershell
npm test -- tests/projectManagerOrchestrator.test.ts tests/projectManagerAnalysis.test.ts tests/projectManagerSignals.test.ts
npm run typecheck
```

- [x] **Step 8: Commit Task 4**

```powershell
git add src/domain/projectManager/orchestrator.ts tests/projectManagerOrchestrator.test.ts
git commit -m "feat: add project manager strategy orchestrator"
```

---

## Task 5: Strategy API And App Wiring

**Subagent:** E

**Files:**

- Modify: `src/app.ts`
- Modify: `src/observability/taskTrackerHumanApi.ts`
- Test: `tests/humanTaskApi.test.ts`

- [x] **Step 1: Add failing API tests for strategy runs**

In `tests/humanTaskApi.test.ts`, add:

```typescript
it("allows operators to run project manager strategy mode with a bounded brief", async () => {
  const runner = {
    runAnalysisOnce: vi.fn(),
    runReplanOnce: vi.fn(),
    runStrategyOnce: vi.fn(async (input) => ({
      run: {
        id: "pm_run_strategy",
        repositoryName: input.repositoryName,
        trigger: "manual",
        mode: "strategy",
        status: "completed",
        proposedGoalIds: [],
        proposedTaskIds: [],
        startedAt: now,
        completedAt: now,
      },
      analysis: {
        id: "pm_analysis_strategy",
        repositoryName: input.repositoryName,
        analysisKind: "strategy",
        summary: "Strategy completed.",
        healthSignals: [],
        proposedGoals: [],
        staleGoalIds: [],
        goalReplans: [],
        strategyAnalysisLenses: [],
        strategyOpportunities: [],
        strategyGoalLinks: [],
        strategyQuestions: [],
        strategyBrief: input.strategyBrief,
        createdAt: now,
      },
      strategy: {
        summary: "Strategy completed.",
        analysisLenses: [],
        opportunities: [],
        goalLinks: [],
        questionsForHuman: [],
      },
    })),
  };
  const projectManagerStore = new InMemoryProjectManagerStore();
  const { baseUrl } = await createServer(tracker, {}, {
    store: projectManagerStore,
    runner,
    executionProfileForRepository: () => ({
      baseBranch: "main",
      queue: "default",
      tags: ["pm"],
    }),
  });

  const response = await requestJson(baseUrl, "/api/project-manager/runs", {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({
      repositoryName: "developer",
      mode: "strategy",
      strategyBrief: "Focus on operator confidence.",
    }),
  });

  expect(response.status).toBe(200);
  expect(runner.runStrategyOnce).toHaveBeenCalledWith({
    repositoryName: "developer",
    trigger: "manual",
    strategyBrief: "Focus on operator confidence.",
    repositoryProfile: {
      baseBranch: "main",
      queue: "default",
      tags: ["pm"],
    },
  });
  expect(await response.json()).toMatchObject({
    result: {
      run: { mode: "strategy", status: "completed" },
      analysis: { analysisKind: "strategy" },
      strategy: { summary: "Strategy completed." },
    },
  });
});

it("rejects oversized strategy briefs before starting a strategy run", async () => {
  const runner = fakeProjectManagerRunner();
  const { baseUrl } = await createServer(tracker, {}, {
    store: new InMemoryProjectManagerStore(),
    runner,
  });

  const response = await requestJson(baseUrl, "/api/project-manager/runs", {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({
      repositoryName: "developer",
      mode: "strategy",
      strategyBrief: "x".repeat(2001),
    }),
  });

  expect(response.status).toBe(400);
  expect(runner.runStrategyOnce).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Add failing API tests for analysis read endpoint**

Add:

```typescript
it("lets viewers read stored strategy analyses", async () => {
  const store = new InMemoryProjectManagerStore();
  await store.recordAnalysis({
    repositoryName: "developer",
    analysisKind: "strategy",
    summary: "Strategy summary.",
    healthSignals: [],
    proposedGoals: [],
    staleGoalIds: [],
    goalReplans: [],
    strategyAnalysisLenses: [{ lens: "strategy", summary: "Frame." }],
    strategyOpportunities: [],
    strategyGoalLinks: [],
    strategyQuestions: [],
  });
  await store.recordAnalysis({
    repositoryName: "developer",
    analysisKind: "analysis",
    summary: "Operational summary.",
    healthSignals: [],
    proposedGoals: [],
    staleGoalIds: [],
    goalReplans: [],
  });

  const { baseUrl } = await createServer(tracker, {}, { store });

  const response = await requestJson(
    baseUrl,
    "/api/project-manager/analyses?repositoryName=developer&analysisKind=strategy",
    { headers: viewerHeaders },
  );

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.analyses).toEqual([
    expect.objectContaining({
      repositoryName: "developer",
      analysisKind: "strategy",
      summary: "Strategy summary.",
      strategy: expect.objectContaining({
        summary: "Strategy summary.",
        analysisLenses: [expect.objectContaining({ lens: "strategy" })],
      }),
    }),
  ]);
});
```

- [x] **Step 3: Run failing API tests**

Run:

```powershell
npm test -- tests/humanTaskApi.test.ts
```

Expected: runner type lacks `runStrategyOnce`, mode route rejects strategy, read endpoint missing.

- [x] **Step 4: Extend API dependencies**

In `src/observability/taskTrackerHumanApi.ts`, extend:

```typescript
runner?: Pick<
  ProjectManagerOrchestrator,
  "runAnalysisOnce" | "runReplanOnce" | "runStrategyOnce"
>;
```

Update `requireProjectManagerRunner` with the same union.

- [x] **Step 5: Add analysis filter parsing**

Add helper:

```typescript
private parseProjectAnalysisFilters(url: URL): {
  repositoryName?: string;
  analysisKind?: ProjectAnalysisKind;
} {
  const repositoryName = optionalString(url.searchParams.get("repositoryName") ?? undefined);
  const rawKind = optionalString(url.searchParams.get("analysisKind") ?? undefined);
  if (rawKind && !PROJECT_ANALYSIS_KINDS.includes(rawKind as ProjectAnalysisKind)) {
    throw new HttpApiError(400, "analysisKind must be one of: analysis, replan, strategy.");
  }
  return {
    ...(repositoryName ? { repositoryName } : {}),
    ...(rawKind ? { analysisKind: rawKind as ProjectAnalysisKind } : {}),
  };
}
```

- [x] **Step 6: Add analyses read route**

In `handleProjectManagerRoute`, before goal route parsing:

```typescript
if (route === "/project-manager/analyses") {
  if (request.method !== "GET") {
    text(response, 405, "method not allowed");
    return true;
  }
  this.requireAuth(request, "viewer");
  const filters = this.parseProjectAnalysisFilters(url);
  const analyses = (await this.requireProjectManagerStore().listAnalyses())
    .filter((analysis) =>
      (!filters.repositoryName || analysis.repositoryName === filters.repositoryName) &&
      (!filters.analysisKind || analysis.analysisKind === filters.analysisKind),
    )
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  json(response, 200, {
    analyses: analyses.map((analysis) => this.summarizeProjectAnalysis(analysis)),
  });
  return true;
}
```

Add `summarizeProjectAnalysis`:

```typescript
private summarizeProjectAnalysis(analysis: ProjectAnalysis): Record<string, unknown> {
  return {
    id: analysis.id,
    repositoryName: analysis.repositoryName,
    analysisKind: analysis.analysisKind,
    summary: analysis.summary,
    createdAt: analysis.createdAt,
    ...(analysis.analysisKind === "strategy"
      ? {
          strategy: {
            summary: analysis.summary,
            analysisLenses: analysis.strategyAnalysisLenses,
            opportunities: analysis.strategyOpportunities,
            goalLinks: analysis.strategyGoalLinks,
            questionsForHuman: analysis.strategyQuestions,
          },
        }
      : {}),
  };
}
```

- [x] **Step 7: Extend run route with strategy**

In `/project-manager/runs` handling:

```typescript
} else if (mode === "strategy") {
  const strategyBrief = optionalString(body.strategyBrief);
  if (strategyBrief && strategyBrief.length > 2000) {
    throw new HttpApiError(400, "strategyBrief must be at most 2000 characters.");
  }
  const repositoryProfile =
    this.input.projectManager?.executionProfileForRepository?.(repositoryName);
  result = await runner.runStrategyOnce({
    repositoryName,
    trigger: "manual",
    ...(strategyBrief ? { strategyBrief } : {}),
    ...(repositoryProfile
      ? {
          repositoryProfile: {
            ...(repositoryProfile.baseBranch ? { baseBranch: repositoryProfile.baseBranch } : {}),
            ...(repositoryProfile.queue ? { queue: repositoryProfile.queue } : {}),
            ...(repositoryProfile.tags ? { tags: repositoryProfile.tags } : {}),
          },
        }
      : {}),
  });
} else {
  throw new HttpApiError(400, "mode must be one of: analysis, replan, strategy.");
}
```

- [x] **Step 8: Wire `runStrategyOnce` in `src/app.ts`**

In `createProjectManagerStoreController`, add to `runner`:

```typescript
runStrategyOnce: async (input) => {
  const repository = fleetConfig.repositories.find(
    (candidate) => candidate.name === input.repositoryName,
  );
  if (!repository) {
    throw new Error(`Project manager repository not found: ${input.repositoryName}`);
  }

  const runtimeConfig = buildRepositoryRuntimeConfig(fleetConfig, repository);
  if (!runtimeConfig.projectManager?.enabled) {
    throw new Error(
      `Project manager is not enabled for repository: ${input.repositoryName}`,
    );
  }

  const codex = new CliCodexRunner(runtimeConfig, logger);
  const orchestrator = new ProjectManagerOrchestrator({
    taskTracker: internalTaskTracker,
    codex,
    store,
    config: runtimeConfig.projectManager,
  });
  return orchestrator.runStrategyOnce({
    ...input,
    repositoryProfile: input.repositoryProfile ?? {
      baseBranch: repository.baseBranch,
      queue: repository.queues[0],
      tags: [...repository.tags],
    },
  });
},
```

- [x] **Step 9: Run API tests**

Run:

```powershell
npm test -- tests/humanTaskApi.test.ts tests/projectManagerOrchestrator.test.ts
npm run typecheck
```

- [x] **Step 10: Commit Task 5**

```powershell
git add src/app.ts src/observability/taskTrackerHumanApi.ts tests/humanTaskApi.test.ts
git commit -m "feat: expose project manager strategy api"
```

---

## Task 6: Angular Service And DTO Support

**Subagent:** F

**Files:**

- Modify: `web/src/app/models/human-api.dto.ts`
- Modify: `web/src/app/services/task-mappers.ts`
- Modify: `web/src/app/services/project-goal.service.ts`
- Test: `web/src/app/services/project-goal.service.spec.ts`

- [x] **Step 1: Add failing service tests**

In `web/src/app/services/project-goal.service.spec.ts`, add:

```typescript
it('runs strategy mode with a strategy brief', () => {
  service.runStrategy('developer', 'Focus on validation trust.').subscribe();

  const request = http.expectOne('/api/project-manager/runs');
  expect(request.request.method).toBe('POST');
  expect(request.request.body).toEqual({
    repositoryName: 'developer',
    mode: 'strategy',
    strategyBrief: 'Focus on validation trust.',
  });
  request.flush({ result: { run: { id: 'pm_run_strategy', mode: 'strategy' } } });
});

it('lists strategy analyses', () => {
  service.listAnalyses({ repositoryName: 'developer', analysisKind: 'strategy' }).subscribe((response) => {
    expect(response.analyses[0].analysisKind).toBe('strategy');
    expect(response.analyses[0].strategy?.summary).toBe('Strategy summary.');
  });

  const request = http.expectOne(
    '/api/project-manager/analyses?repositoryName=developer&analysisKind=strategy',
  );
  expect(request.request.method).toBe('GET');
  request.flush({
    analyses: [
      {
        id: 'pm_analysis_strategy',
        repositoryName: 'developer',
        analysisKind: 'strategy',
        summary: 'Strategy summary.',
        strategy: {
          summary: 'Strategy summary.',
          analysisLenses: [],
          opportunities: [],
          goalLinks: [],
          questionsForHuman: [],
        },
        createdAt: '2026-05-28T00:00:00.000Z',
      },
    ],
  });
});
```

- [x] **Step 2: Run failing Angular service tests**

Run:

```powershell
npm run web:test -- --include web/src/app/services/project-goal.service.spec.ts
```

If the Angular test runner does not support `--include`, run:

```powershell
npm run web:test
```

Expected: missing methods and DTOs.

- [x] **Step 3: Add DTOs**

In `web/src/app/models/human-api.dto.ts`, add:

```typescript
export type ProjectAnalysisKindDto = 'analysis' | 'replan' | 'strategy';
export type ProjectStrategyDimensionDto = 'product' | 'technical' | 'product_technical';
export type ProjectStrategyNextStepDto = 'create_goal' | 'research' | 'ask_human' | 'defer';
export type ProjectStrategyArchitectVerdictDto = 'pursue' | 'research_first' | 'defer' | 'reject';

export interface ProjectStrategyLensSummaryDto {
  lens: string;
  summary: string;
}

export interface ProjectStrategyOpportunityDto {
  opportunityId: string;
  dimension: ProjectStrategyDimensionDto;
  title: string;
  problemStatement: string;
  userOrBusinessImpact: string;
  technicalImpact: string;
  evidenceRefs: EvidenceRefDto[];
  confidence: number;
  priority: ProjectGoalPriorityDto;
  riskLevel: ProjectGoalRiskLevelDto;
  recommendedNextStep: ProjectStrategyNextStepDto;
  rationale: string;
  redTeamNotes: string[];
  architectVerdict: ProjectStrategyArchitectVerdictDto;
}

export interface ProjectStrategyGoalLinkDto {
  sourceOpportunityId: string;
  proposedGoalTitle: string;
  evidenceRefs: EvidenceRefDto[];
}

export interface ProjectStrategyQuestionDto {
  question: string;
  whyItMatters: string;
  relatedOpportunityId?: string;
  relatedOpportunityTitle?: string;
}

export interface ProjectStrategyAnalysisDto {
  summary: string;
  analysisLenses: ProjectStrategyLensSummaryDto[];
  opportunities: ProjectStrategyOpportunityDto[];
  goalLinks: ProjectStrategyGoalLinkDto[];
  questionsForHuman: ProjectStrategyQuestionDto[];
}

export interface ProjectAnalysisDto {
  id: string;
  repositoryName: string;
  analysisKind: ProjectAnalysisKindDto;
  summary: string;
  strategy?: ProjectStrategyAnalysisDto;
  createdAt: string;
}

export interface ProjectAnalysisListResponseDto {
  analyses: ProjectAnalysisDto[];
}
```

- [x] **Step 4: Add mappers**

In `web/src/app/services/task-mappers.ts`, add mapper functions:

```typescript
const numberValue = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
```

Add:

```typescript
export const mapProjectStrategyOpportunity = (value: unknown): ProjectStrategyOpportunityDto => {
  const raw = record(value);
  return {
    opportunityId: stringValue(raw['opportunityId']),
    dimension: stringValue(raw['dimension'], 'technical') as ProjectStrategyDimensionDto,
    title: stringValue(raw['title']),
    problemStatement: stringValue(raw['problemStatement']),
    userOrBusinessImpact: stringValue(raw['userOrBusinessImpact']),
    technicalImpact: stringValue(raw['technicalImpact']),
    evidenceRefs: records(raw['evidenceRefs']).map(mapEvidenceRef),
    confidence: numberValue(raw['confidence']),
    priority: stringValue(raw['priority'], 'normal') as ProjectGoalPriorityDto,
    riskLevel: stringValue(raw['riskLevel'], 'medium') as ProjectGoalRiskLevelDto,
    recommendedNextStep: stringValue(raw['recommendedNextStep'], 'defer') as ProjectStrategyNextStepDto,
    rationale: stringValue(raw['rationale']),
    redTeamNotes: stringArray(raw['redTeamNotes']),
    architectVerdict: stringValue(raw['architectVerdict'], 'defer') as ProjectStrategyArchitectVerdictDto,
  };
};

export const mapProjectStrategyAnalysis = (value: unknown): ProjectStrategyAnalysisDto => {
  const raw = record(value);
  return {
    summary: stringValue(raw['summary']),
    analysisLenses: records(raw['analysisLenses']).map((lens) => ({
      lens: stringValue(lens['lens']),
      summary: stringValue(lens['summary']),
    })),
    opportunities: records(raw['opportunities']).map(mapProjectStrategyOpportunity),
    goalLinks: records(raw['goalLinks']).map((link) => ({
      sourceOpportunityId: stringValue(link['sourceOpportunityId']),
      proposedGoalTitle: stringValue(link['proposedGoalTitle']),
      evidenceRefs: records(link['evidenceRefs']).map(mapEvidenceRef),
    })),
    questionsForHuman: records(raw['questionsForHuman']).map((question) => ({
      question: stringValue(question['question']),
      whyItMatters: stringValue(question['whyItMatters']),
      ...(optionalString(question['relatedOpportunityId'])
        ? { relatedOpportunityId: optionalString(question['relatedOpportunityId']) }
        : {}),
      ...(optionalString(question['relatedOpportunityTitle'])
        ? { relatedOpportunityTitle: optionalString(question['relatedOpportunityTitle']) }
        : {}),
    })),
  };
};

export const mapProjectAnalysis = (value: unknown): ProjectAnalysisDto => {
  const raw = record(value);
  const strategy = raw['strategy'] ? mapProjectStrategyAnalysis(raw['strategy']) : undefined;
  return {
    id: stringValue(raw['id']),
    repositoryName: stringValue(raw['repositoryName']),
    analysisKind: stringValue(raw['analysisKind'], 'analysis') as ProjectAnalysisKindDto,
    summary: stringValue(raw['summary']),
    ...(strategy ? { strategy } : {}),
    createdAt: stringValue(raw['createdAt']),
  };
};

export const mapProjectAnalysisListResponse = (
  value: unknown,
): ProjectAnalysisListResponseDto => {
  const raw = record(value);
  return {
    analyses: records(raw['analyses']).map(mapProjectAnalysis),
  };
};
```

- [x] **Step 5: Add service methods**

In `web/src/app/services/project-goal.service.ts`, import the new mapper and DTO. Add:

```typescript
runStrategy(repositoryName: string, strategyBrief?: string): Observable<unknown> {
  return this.api.post<
    { repositoryName: string; mode: 'strategy'; strategyBrief?: string },
    unknown
  >('/project-manager/runs', {
    repositoryName,
    mode: 'strategy',
    ...(strategyBrief?.trim() ? { strategyBrief: strategyBrief.trim() } : {}),
  });
}

listAnalyses(input: {
  repositoryName?: string;
  analysisKind?: ProjectAnalysisKindDto;
} = {}): Observable<ProjectAnalysisListResponseDto> {
  let params = new HttpParams();
  if (input.repositoryName) {
    params = params.set('repositoryName', input.repositoryName);
  }
  if (input.analysisKind) {
    params = params.set('analysisKind', input.analysisKind);
  }
  return this.api
    .get<unknown>('/project-manager/analyses', params)
    .pipe(map(mapProjectAnalysisListResponse));
}
```

- [x] **Step 6: Run Angular service checks**

Run:

```powershell
npm run web:typecheck
npm run web:test
```

- [x] **Step 7: Commit Task 6**

```powershell
git add web/src/app/models/human-api.dto.ts web/src/app/services/task-mappers.ts web/src/app/services/project-goal.service.ts web/src/app/services/project-goal.service.spec.ts
git commit -m "feat: add strategy api models to web client"
```

---

## Task 7: Minimal Strategy UI

**Subagent:** F

**Files:**

- Modify: `web/src/app/pages/goals-page.component.ts`
- Test: `web/src/app/pages/workflow-pages.spec.ts`

- [ ] **Step 1: Add failing UI test**

In `web/src/app/pages/workflow-pages.spec.ts`, add a goals page test:

```typescript
it('lets operators run strategy mode and renders latest strategy opportunities', async () => {
  const http = await configure([GoalsPageComponent]);
  loadSession(http, pmOperatorSession);

  const fixture = TestBed.createComponent(GoalsPageComponent);
  fixture.detectChanges();

  http.expectOne('/api/project-goals?status=proposed').flush({
    goals: [],
    linkedTaskCounts: {},
    role: 'operator',
    generatedAt: now,
  });
  http.expectOne('/api/project-manager/analyses?analysisKind=strategy').flush({
    analyses: [
      {
        id: 'pm_analysis_strategy',
        repositoryName: 'developer',
        analysisKind: 'strategy',
        summary: 'Strategy summary.',
        strategy: {
          summary: 'Strategy summary.',
          analysisLenses: [{ lens: 'strategy', summary: 'Focus on validation trust.' }],
          opportunities: [
            {
              opportunityId: 'opp-1',
              dimension: 'technical',
              title: 'Improve validation trust',
              problemStatement: 'Weak evidence.',
              userOrBusinessImpact: 'Operators lose confidence.',
              technicalImpact: 'Quality signals are weak.',
              evidenceRefs: [],
              confidence: 80,
              priority: 'high',
              riskLevel: 'medium',
              recommendedNextStep: 'create_goal',
              rationale: 'Supported.',
              redTeamNotes: ['Keep scope narrow.'],
              architectVerdict: 'pursue',
            },
          ],
          goalLinks: [
            {
              sourceOpportunityId: 'opp-1',
              proposedGoalTitle: 'Improve validation trust',
              evidenceRefs: [],
            },
          ],
          questionsForHuman: [],
        },
        createdAt: now,
      },
    ],
  });
  fixture.detectChanges();

  expect((fixture.nativeElement as HTMLElement).textContent).toContain('Improve validation trust');

  const brief = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
    '[data-testid="goals-strategy-brief"]',
  )!;
  brief.value = 'Focus on operator confidence.';
  brief.dispatchEvent(new Event('input'));
  (fixture.nativeElement as HTMLElement)
    .querySelector<HTMLElement>('[data-testid="goals-run-strategy"]')!
    .click();

  const request = http.expectOne('/api/project-manager/runs');
  expect(request.request.body).toEqual({
    repositoryName: 'developer',
    mode: 'strategy',
    strategyBrief: 'Focus on operator confidence.',
  });
});
```

- [ ] **Step 2: Run failing UI tests**

Run:

```powershell
npm run web:test
```

Expected: missing strategy controls/rendering.

- [ ] **Step 3: Add component state**

In `goals-page.component.ts`, add:

```typescript
protected readonly strategyBriefControl = new FormControl<string>('', {
  nonNullable: true,
});
protected readonly runningStrategy = signal(false);
protected readonly strategyAnalyses = signal<ProjectAnalysisDto[]>([]);
```

Add `OnInit` loading:

```typescript
ngOnInit(): void {
  this.load();
  this.loadStrategyAnalyses();
}
```

If `ngOnInit` already calls `load()`, add only `this.loadStrategyAnalyses();`.

- [ ] **Step 4: Add load and run methods**

Add:

```typescript
protected loadStrategyAnalyses(): void {
  this.goalsApi
    .listAnalyses({
      repositoryName: this.repositoryFilter.value.trim() || undefined,
      analysisKind: 'strategy',
    })
    .subscribe({
      next: (response) => this.strategyAnalyses.set(response.analyses),
      error: (error: unknown) => this.error.set(this.errorMessage(error)),
    });
}

protected runStrategy(): void {
  const repositoryName = this.repositoryFilter.value.trim();
  if (!repositoryName) {
    this.error.set('Укажите репозиторий для strategy run.');
    return;
  }
  const brief = this.strategyBriefControl.value.trim();
  this.runningStrategy.set(true);
  this.goalsApi.runStrategy(repositoryName, brief).subscribe({
    next: () => {
      this.notice.set('Strategy Project Manager запущен.');
      this.runningStrategy.set(false);
      this.load();
      this.loadStrategyAnalyses();
    },
    error: (error: unknown) => {
      this.runningStrategy.set(false);
      this.error.set(this.errorMessage(error));
    },
  });
}

protected latestStrategy(): ProjectAnalysisDto | undefined {
  return this.strategyAnalyses()[0];
}
```

When existing `load()` refreshes goals by repository filter, call `this.loadStrategyAnalyses()` after a successful refresh so the strategy section follows the current repository filter.

- [ ] **Step 5: Add template controls**

In the header action area, add:

```html
@if (canRunProjectManager()) {
  <div class="strategy-run">
    <input
      pInputText
      type="text"
      data-testid="goals-strategy-brief"
      [formControl]="strategyBriefControl"
      maxlength="2000"
      placeholder="Strategy brief"
    />
    <button
      pButton
      type="button"
      data-testid="goals-run-strategy"
      icon="pi pi-compass"
      label="Запустить strategy"
      [disabled]="runningStrategy()"
      (click)="runStrategy()"
    ></button>
  </div>
}
```

Place this near the existing run analysis button, not inside a goal card.

- [ ] **Step 6: Add compact strategy result section**

Below notices/errors and before the goals list, add:

```html
@if (latestStrategy(); as analysis) {
  <section class="surface strategy-summary" data-testid="goals-strategy-summary">
    <div class="strategy-summary__header">
      <div>
        <span class="eyebrow">{{ analysis.id }}</span>
        <h2>{{ analysis.strategy?.summary || analysis.summary }}</h2>
      </div>
      <span>{{ formatDate(analysis.createdAt) }}</span>
    </div>

    @if (analysis.strategy?.analysisLenses?.length) {
      <div class="tag-row">
        @for (lens of analysis.strategy.analysisLenses; track lens.lens) {
          <p-tag [value]="lens.lens" severity="secondary" />
        }
      </div>
    }

    @if (analysis.strategy?.opportunities?.length) {
      <div class="strategy-opportunities">
        @for (opportunity of analysis.strategy.opportunities; track opportunity.opportunityId) {
          <article class="strategy-opportunity">
            <div>
              <span class="eyebrow">{{ opportunity.dimension }} · {{ opportunity.architectVerdict }}</span>
              <h3>{{ opportunity.title }}</h3>
              <p>{{ opportunity.rationale }}</p>
            </div>
            <div class="tag-row">
              <p-tag [value]="'Confidence: ' + opportunity.confidence" severity="info" />
              <p-tag [value]="opportunity.priority" [severity]="prioritySeverity(opportunity.priority)" />
              <p-tag [value]="opportunity.recommendedNextStep" severity="secondary" />
            </div>
            @if (opportunity.redTeamNotes.length) {
              <ul>
                @for (note of opportunity.redTeamNotes; track note) {
                  <li>{{ note }}</li>
                }
              </ul>
            }
          </article>
        }
      </div>
    }
  </section>
}
```

- [ ] **Step 7: Add focused CSS inside component styles**

Add styles near the existing component style block:

```css
.strategy-run {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.strategy-run input {
  min-width: min(26rem, 100%);
}

.strategy-summary {
  display: grid;
  gap: 1rem;
}

.strategy-summary__header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
}

.strategy-opportunities {
  display: grid;
  gap: 0.75rem;
}

.strategy-opportunity {
  display: grid;
  gap: 0.5rem;
  padding-block: 0.75rem;
  border-top: 1px solid var(--surface-border);
}
```

- [ ] **Step 8: Run web checks**

Run:

```powershell
npm run web:typecheck
npm run web:test
```

- [ ] **Step 9: Commit Task 7**

```powershell
git add web/src/app/pages/goals-page.component.ts web/src/app/pages/workflow-pages.spec.ts
git commit -m "feat: render project manager strategy results"
```

---

## Task 8: E2E Strategy Flow

**Subagent:** G

**Files:**

- Modify: `web/e2e/mock-console-server.mjs`
- Modify: `web/e2e/console-critical-flows.spec.ts`

- [ ] **Step 1: Extend mock server state**

In `web/e2e/mock-console-server.mjs`, add a strategy analysis fixture to the in-memory state:

```javascript
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
```

If the mock state currently uses separate collections, add `projectAnalyses` beside `projectGoals` and keep it as an array sorted newest first.

- [ ] **Step 2: Add mock read endpoint**

In the mock request handler, add:

```javascript
if (request.method === 'GET' && pathname === '/api/project-manager/analyses') {
  const repositoryName = url.searchParams.get('repositoryName');
  const analysisKind = url.searchParams.get('analysisKind');
  const analyses = state.projectAnalyses.filter((analysis) =>
    (!repositoryName || analysis.repositoryName === repositoryName) &&
    (!analysisKind || analysis.analysisKind === analysisKind),
  );
  json(response, 200, { analyses });
  return;
}
```

- [ ] **Step 3: Extend mock strategy run**

In `POST /api/project-manager/runs`, add strategy handling before analysis fallback:

```javascript
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
    evidenceRefs: [{ kind: 'snapshot', ref: 'projectSignals.failedTasks', summary: 'Failed tasks exist.' }],
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
```

- [ ] **Step 4: Add Playwright test**

In `web/e2e/console-critical-flows.spec.ts`, add:

```typescript
test('operator runs strategy mode and sees a strategy-created goal', async ({ browser }) => {
  const operator = await newRolePage(browser, 'operator');
  const page = operator.page;

  await page.goto('/tasks/goals');
  await expect(page.getByTestId('goals-page')).toBeVisible();
  await expect(page.getByTestId('goals-strategy-summary')).toContainText('Improve validation trust');
  await page.getByTestId('goals-strategy-brief').fill('Focus on operator confidence.');
  await page.getByTestId('goals-run-strategy').click();
  await expect(page.getByTestId('goals-strategy-summary')).toContainText(
    'Strategy identified validation trust',
  );
  await expect(page.getByText('Improve validation trust').first()).toBeVisible();

  await operator.close();
});

test('viewer can read strategy output but cannot run strategy mode', async ({ browser }) => {
  const viewer = await newRolePage(browser, 'viewer');
  const page = viewer.page;

  await page.goto('/tasks/goals');
  await expect(page.getByTestId('goals-page')).toBeVisible();
  await expect(page.getByTestId('goals-strategy-summary')).toContainText('Improve validation trust');
  await expect(page.getByTestId('goals-run-strategy')).toHaveCount(0);

  await viewer.close();
});
```

- [ ] **Step 5: Run E2E**

Run:

```powershell
npm run web:e2e
```

- [ ] **Step 6: Commit Task 8**

```powershell
git add web/e2e/mock-console-server.mjs web/e2e/console-critical-flows.spec.ts
git commit -m "test: cover project manager strategy flow"
```

---

## Task 9: Final Verification, Review, And Cleanup

**Subagent:** Coordinator

**Files:**

- Modify docs only if roadmap status exists and needs a new line.

- [ ] **Step 1: Run focused backend PM tests**

Run:

```powershell
npm test -- tests/projectManagerAnalysis.test.ts tests/projectManagerPrompt.test.ts tests/projectManagerSignals.test.ts tests/projectManagerOrchestrator.test.ts tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts tests/humanTaskApi.test.ts
```

Expected: all focused PM tests pass. If `TASK_TRACKER_TEST_DATABASE_URL` is unset, report that real PostgreSQL integration tests were skipped.

- [ ] **Step 2: Run full backend checks**

Run:

```powershell
npm run typecheck
npm test
npm run build
```

Expected: TypeScript, Vitest, and production build pass.

- [ ] **Step 3: Run full web checks**

Run:

```powershell
npm run web:typecheck
npm run web:test
npm run web:e2e
```

Expected: Angular typecheck, unit tests, and Playwright pass.

- [ ] **Step 4: Remove generated Playwright output if present**

Run:

```powershell
if (Test-Path 'web/test-results') {
  $target = Resolve-Path -LiteralPath 'web/test-results'
  $root = Resolve-Path -LiteralPath '.'
  if (-not $target.Path.StartsWith($root.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove outside workspace: $($target.Path)"
  }
  Remove-Item -LiteralPath $target.Path -Recurse -Force
}
```

- [ ] **Step 5: Request code review subagents**

Dispatch two review subagents after implementation:

Backend review prompt:

```text
Review the Project Manager strategy mode backend diff. Focus on safety invariants, parser/policy strictness, strategy opportunity to goal linking, evidence overlap checks, PostgreSQL migration compatibility, run mode auditability, and preservation of analysis/replan behavior. Report Critical and Important findings first with file/line references.
```

Frontend/API review prompt:

```text
Review the Project Manager strategy mode API and Angular diff. Focus on role gating, response shape compatibility, strategy brief validation, DTO mapping resilience, compact UI rendering, and absence of any UI path that creates tasks directly from strategy output. Report Critical and Important findings first with file/line references.
```

Fix Critical and Important findings before final verification.

- [ ] **Step 6: Run final regression after review fixes**

Run:

```powershell
npm run typecheck
npm test
npm run build
npm run web:typecheck
npm run web:test
npm run web:e2e
```

- [ ] **Step 7: Commit final fixes**

```powershell
git add src tests web docs
git commit -m "feat: add project manager strategy mode"
```

Use this commit only if previous task commits were not already created. If task commits already exist, commit only the final review fixes with:

```powershell
git add src tests web docs
git commit -m "fix: address project manager strategy review"
```

---

## Safety Checklist

- [ ] Strategy mode starts PM runs with `mode: "strategy"`.
- [ ] Failed strategy runs retain `ProjectManagerRun.mode = "strategy"`.
- [ ] Strategy analyses persist `analysisKind = "strategy"`.
- [ ] Strategy Codex execution uses `sandbox: "read-only"`.
- [ ] Strategy prompt says to analyze only the bounded snapshot.
- [ ] Strategy path does not inspect repository files directly in the first slice.
- [ ] Strategy path does not call external services from PM prompt.
- [ ] Strategy path does not call `createTask`.
- [ ] Strategy path does not call `proposeTask`.
- [ ] Strategy path does not approve proposals.
- [ ] Strategy path does not bypass goal approval.
- [ ] Only strategy `proposedGoals` create `ProjectGoal` records.
- [ ] Raw strategy `opportunities` remain advisory metadata.
- [ ] Every strategy proposed goal has a valid `sourceOpportunityId`.
- [ ] Every materialized strategy goal overlaps evidence with its referenced opportunity.
- [ ] `architectVerdict !== "pursue"` prevents goal materialization.
- [ ] `create_goal` with confidence below 60 is rejected.
- [ ] High-risk strategy goals cannot fan out broad executable proposals.
- [ ] Viewer can read strategy analyses.
- [ ] Operator can run strategy.
- [ ] Developer without operator role cannot run strategy.
- [ ] Existing analysis/replan API behavior remains backward compatible.

## Final Expected Verification

Run before claiming strategy mode complete:

```powershell
npm test -- tests/projectManagerAnalysis.test.ts tests/projectManagerPrompt.test.ts tests/projectManagerSignals.test.ts tests/projectManagerOrchestrator.test.ts tests/projectManagerGoalStore.test.ts tests/projectManagerPostgresStore.test.ts tests/humanTaskApi.test.ts
npm run typecheck
npm test
npm run build
npm run web:typecheck
npm run web:test
npm run web:e2e
```

Report explicitly:

- whether real PostgreSQL integration tests ran or were skipped;
- whether Playwright passed;
- whether any review findings remain open.
