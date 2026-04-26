import type {
  PromptProfile,
  PromptProfileOverrideMap,
  TaskAnalysisDecision,
  TaskType,
  TrackerIssue,
} from "../models/types.js";

export const BUILT_IN_PROMPT_PROFILES: Record<string, PromptProfile> = {
  frontend_ui_fix: {
    id: "frontend_ui_fix",
    taskType: "frontend_ui_fix",
    matchHints: ["ui", "frontend", "component", "css", "style", "layout", "accessibility"],
    implementationInstructions: [
      "Keep UI changes scoped to the affected component or screen.",
      "Preserve existing design-system conventions and accessibility behavior.",
      "Check responsive states for any touched layout or interaction.",
    ],
    validationFocus: [
      "Run configured lint, tests, and visual regression checks when available.",
      "Verify that user-visible text and interactive states still fit at common viewport sizes.",
    ],
    riskChecklist: [
      "Visual regression in adjacent states.",
      "Keyboard, focus, and screen-reader behavior.",
      "Responsive layout shifts.",
    ],
  },
  backend_endpoint: {
    id: "backend_endpoint",
    taskType: "backend_endpoint",
    matchHints: ["api", "endpoint", "controller", "handler", "route", "validation"],
    implementationInstructions: [
      "Keep request validation, persistence, and service boundaries explicit.",
      "Prefer existing error handling and response-shaping helpers.",
      "Avoid changing public contracts unless the task explicitly requires it.",
    ],
    validationFocus: [
      "Exercise success and failure paths for the touched endpoint or service.",
      "Check authorization, validation, and persistence side effects.",
    ],
    riskChecklist: [
      "Backward-incompatible API behavior.",
      "Missing validation or authorization.",
      "Data consistency or migration side effects.",
    ],
  },
  tests_only: {
    id: "tests_only",
    taskType: "tests_only",
    matchHints: ["test", "coverage", "spec", "vitest", "jest", "unit test"],
    implementationInstructions: [
      "Prefer adding or fixing tests without production changes.",
      "Only modify production code when the test exposes a real bug needed for the task.",
      "Keep assertions focused on observable behavior.",
    ],
    validationFocus: [
      "Run the focused test file first when possible, then the configured test command.",
      "Ensure new tests fail for the intended reason before production fixes when feasible.",
    ],
    riskChecklist: [
      "Brittle assertions tied to implementation details.",
      "Production changes hidden in a tests-only task.",
      "Uncovered negative paths.",
    ],
  },
  refactor: {
    id: "refactor",
    taskType: "refactor",
    matchHints: ["refactor", "cleanup", "simplify", "extract", "rename"],
    implementationInstructions: [
      "Preserve existing behavior and public APIs unless explicitly requested.",
      "Keep the refactor incremental and easy to review.",
      "Avoid broad formatting churn or unrelated cleanup.",
    ],
    validationFocus: [
      "Run broad checks for the touched subsystem because behavior should not change.",
      "Compare changed files against the stated refactor scope.",
    ],
    riskChecklist: [
      "Behavior drift hidden by structural changes.",
      "Over-broad file churn.",
      "Missed call sites after renames or moves.",
    ],
  },
  dependency_update: {
    id: "dependency_update",
    taskType: "dependency_update",
    matchHints: ["dependency", "package", "lockfile", "upgrade", "version", "npm audit"],
    implementationInstructions: [
      "Update dependency manifests and lockfiles together.",
      "Call out migration notes when an updated dependency changes behavior.",
      "Keep unrelated dependency churn out of the change.",
    ],
    validationFocus: [
      "Run install/build/test checks that prove the lockfile and runtime are consistent.",
      "Inspect changelog-sensitive areas touched by the dependency update.",
    ],
    riskChecklist: [
      "Transitive dependency breakage.",
      "Lockfile drift.",
      "Runtime or build-tool compatibility changes.",
    ],
  },
  documentation: {
    id: "documentation",
    taskType: "documentation",
    matchHints: ["docs", "readme", "runbook", "documentation", "guide"],
    implementationInstructions: [
      "Keep docs accurate to the current code and configuration.",
      "Prefer concise operational examples over broad prose.",
      "Do not change runtime code for documentation-only tasks unless required to verify docs.",
    ],
    validationFocus: [
      "Check links, command names, and environment variable names against the repository.",
      "Run typecheck/tests only when documentation changes include executable examples or generated docs.",
    ],
    riskChecklist: [
      "Stale command examples.",
      "Undocumented configuration defaults.",
      "Docs diverging from code behavior.",
    ],
  },
  general: {
    id: "general",
    taskType: "unknown",
    matchHints: [],
    implementationInstructions: [
      "Follow the repository architecture and coding style.",
      "Keep edits scoped to the task and avoid unrelated refactors.",
      "Ask for clarification when critical business context is missing.",
    ],
    validationFocus: [
      "Run the configured quality gates before publishing.",
      "Verify changed files match the requested behavior.",
    ],
    riskChecklist: [
      "Unclear acceptance criteria.",
      "Unexpected changes outside the task scope.",
      "Missing tests for touched behavior.",
    ],
  },
};

const taskTypeToProfileId: Record<TaskType, string> = {
  frontend_ui_fix: "frontend_ui_fix",
  backend_endpoint: "backend_endpoint",
  tests_only: "tests_only",
  refactor: "refactor",
  dependency_update: "dependency_update",
  documentation: "documentation",
  unknown: "general",
};

const normalize = (value: string): string => value.trim().toLowerCase();

const mergeUnique = (base: string[], override: string[] | undefined): string[] =>
  override ? [...new Set([...base, ...override])] : base;

export const hasPromptProfile = (profileId: string): boolean =>
  Object.prototype.hasOwnProperty.call(BUILT_IN_PROMPT_PROFILES, profileId);

export const getPromptProfile = (
  profileId: string,
  overrides?: PromptProfileOverrideMap,
): PromptProfile => {
  const base =
    BUILT_IN_PROMPT_PROFILES[profileId] ?? BUILT_IN_PROMPT_PROFILES.general;
  if (!base) {
    throw new Error("Built-in general prompt profile is not configured.");
  }
  const override = overrides?.[base.id];

  return {
    ...base,
    matchHints: mergeUnique(base.matchHints, override?.matchHints),
    implementationInstructions: mergeUnique(
      base.implementationInstructions,
      override?.implementationInstructions,
    ),
    validationFocus: mergeUnique(base.validationFocus, override?.validationFocus),
    riskChecklist: mergeUnique(base.riskChecklist, override?.riskChecklist),
  };
};

const issueSearchText = (issue: TrackerIssue): string =>
  [
    issue.title,
    issue.description,
    ...(issue.tags ?? []),
    ...(issue.components ?? []),
  ]
    .join(" ")
    .toLowerCase();

const heuristicProfileId = (issue: TrackerIssue): string => {
  const text = issueSearchText(issue);
  const matches = Object.values(BUILT_IN_PROMPT_PROFILES)
    .filter((profile) => profile.id !== "general")
    .map((profile) => ({
      profile,
      score: profile.matchHints.reduce(
        (total, hint) => total + (text.includes(normalize(hint)) ? 1 : 0),
        0,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  return matches[0]?.profile.id ?? "general";
};

export const selectPromptProfile = (
  issue: TrackerIssue,
  analysisDecision?: TaskAnalysisDecision,
  overrides?: PromptProfileOverrideMap,
): PromptProfile => {
  if (analysisDecision?.promptProfileId && hasPromptProfile(analysisDecision.promptProfileId)) {
    return getPromptProfile(analysisDecision.promptProfileId, overrides);
  }

  if (analysisDecision?.taskType) {
    const profileId = taskTypeToProfileId[analysisDecision.taskType];
    if (profileId && hasPromptProfile(profileId)) {
      return getPromptProfile(profileId, overrides);
    }
  }

  return getPromptProfile(heuristicProfileId(issue), overrides);
};
