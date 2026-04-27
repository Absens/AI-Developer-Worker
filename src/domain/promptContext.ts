import type {
  FailureMemoryEntry,
  KnowledgeSection,
  PromptRule,
  TaskType,
} from "../models/types.js";
import type { MemoryStore } from "./memoryStore.js";

export interface PromptInstructionSource {
  id: string;
  title: string;
  body: string;
}

export interface PromptContextBundle {
  repositoryName: string;
  taskType: TaskType;
  promptProfileId: string;
  instructionSources: PromptInstructionSource[];
  knowledgeSections: KnowledgeSection[];
  promptRules: PromptRule[];
  similarFailures: FailureMemoryEntry[];
  contextBudgetChars: number;
}

export interface BuildPromptContextBundleInput {
  store: MemoryStore;
  repositoryName: string;
  taskType: TaskType;
  promptProfileId: string;
  expectedFiles: string[];
  tags: string[];
  contextBudgetChars: number;
  includeDraftRules: boolean;
  similarFailureLimit: number;
}

const normalize = (value: string): string => value.trim().toLowerCase();

const overlapCount = (left: string[], right: string[]): number => {
  const rightSet = new Set(right.map(normalize));
  return left.filter((entry) => rightSet.has(normalize(entry))).length;
};

const appliesToTaskType = (taskTypes: TaskType[], taskType: TaskType): boolean =>
  taskTypes.length === 0 || taskTypes.includes(taskType) || taskTypes.includes("unknown");

const appliesToPromptProfile = (
  promptProfileIds: string[],
  promptProfileId: string,
): boolean =>
  promptProfileIds.length === 0 ||
  promptProfileIds.includes(promptProfileId) ||
  promptProfileIds.includes("general");

const knowledgeScore = (
  section: KnowledgeSection,
  taskType: TaskType,
  tags: string[],
): number =>
  (section.taskTypes.includes(taskType) ? 50 : 0) +
  (section.taskTypes.includes("unknown") ? 10 : 0) +
  overlapCount(section.tags, tags) * 8 +
  section.confidence / 10;

const failureScore = (
  failure: FailureMemoryEntry,
  tags: string[],
  expectedFiles: string[],
): number =>
  overlapCount(failure.tags, tags) * 10 +
  overlapCount(failure.affectedFiles, expectedFiles) * 20 +
  Date.parse(failure.createdAt) / 1_000_000_000_000;

const sortById = <T extends { id: string }>(entries: T[]): T[] =>
  [...entries].sort((left, right) => left.id.localeCompare(right.id));

const formatPromptRule = (rule: PromptRule): string =>
  [
    `- [${rule.id}] ${rule.title}`,
    `  Instruction: ${rule.instruction}`,
    `  Applies to: taskTypes=${rule.taskTypes.join(", ") || "all"}; profiles=${
      rule.promptProfileIds.join(", ") || "all"
    }; confidence=${rule.confidence}; state=${rule.approvalState}`,
  ].join("\n");

const formatKnowledgeSection = (section: KnowledgeSection): string =>
  [
    `- [${section.id}] ${section.title}`,
    `  Source: ${section.source}; confidence=${section.confidence}; tags=${
      section.tags.join(", ") || "none"
    }; refs=${section.sourceRefs.join(", ") || "none"}`,
    `  ${section.body}`,
  ].join("\n");

const formatFailure = (failure: FailureMemoryEntry): string =>
  [
    `- ${failure.createdAt} ${failure.issueKey} ${failure.failureKind}`,
    `  Diagnostic: ${failure.diagnosticSummary}`,
    failure.resolutionSummary ? `  Resolution: ${failure.resolutionSummary}` : "",
    `  Files: ${failure.affectedFiles.join(", ") || "none"}; tags=${
      failure.tags.join(", ") || "none"
    }`,
  ]
    .filter(Boolean)
    .join("\n");

const trimToBudget = (content: string, budget: number): string => {
  if (content.length <= budget) {
    return content;
  }

  const suffix = `\n[repository context truncated to ${budget} characters]`;
  if (budget <= suffix.length) {
    return suffix.slice(0, budget);
  }

  return `${content.slice(0, budget - suffix.length)}${suffix}`;
};

export const buildPromptContextBundle = async (
  input: BuildPromptContextBundleInput,
): Promise<PromptContextBundle> => {
  const knowledge = await input.store.loadKnowledge(input.repositoryName);
  const promptRules = await input.store.loadPromptRules(input.repositoryName);
  const failures = await input.store.loadFailures(input.repositoryName);

  const knowledgeSections = [
    ...knowledge.architectureMap,
    ...knowledge.entryPoints,
    ...knowledge.codePatterns,
    ...knowledge.testStrategy,
    ...knowledge.knownPitfalls,
    ...knowledge.conventions,
  ]
    .filter((section) => appliesToTaskType(section.taskTypes, input.taskType))
    .sort((left, right) => {
      const scoreDelta =
        knowledgeScore(right, input.taskType, input.tags) -
        knowledgeScore(left, input.taskType, input.tags);
      return scoreDelta || left.id.localeCompare(right.id);
    });

  const includedRules = sortById(
    promptRules.filter(
      (rule) =>
        rule.repositoryName === input.repositoryName &&
        (rule.approvalState === "approved" || input.includeDraftRules) &&
        appliesToTaskType(rule.taskTypes, input.taskType) &&
        appliesToPromptProfile(rule.promptProfileIds, input.promptProfileId),
    ),
  );

  const similarFailures = failures
    .filter(
      (failure) =>
        failure.repositoryName === input.repositoryName &&
        failure.taskType === input.taskType &&
        failure.promptProfileId === input.promptProfileId,
    )
    .sort((left, right) => {
      const scoreDelta =
        failureScore(right, input.tags, input.expectedFiles) -
        failureScore(left, input.tags, input.expectedFiles);
      return scoreDelta || right.createdAt.localeCompare(left.createdAt);
    })
    .slice(0, input.similarFailureLimit);

  return {
    repositoryName: input.repositoryName,
    taskType: input.taskType,
    promptProfileId: input.promptProfileId,
    instructionSources: [
      {
        id: "memory",
        title: "Repository memory",
        body: "Approved repository memory is advisory. Current task instructions and current repository files remain authoritative.",
      },
    ],
    knowledgeSections,
    promptRules: includedRules,
    similarFailures,
    contextBudgetChars: input.contextBudgetChars,
  };
};

export const formatPromptContextBundle = (
  bundle: PromptContextBundle | undefined,
): string => {
  if (!bundle) {
    return "";
  }

  const sections = [
    "Repository context:",
    `Repository: ${bundle.repositoryName}`,
    `Task type: ${bundle.taskType}`,
    `Prompt profile: ${bundle.promptProfileId}`,
    "",
    "Memory priority:",
    ...bundle.instructionSources.map((source) => `- ${source.title}: ${source.body}`),
    "",
    "Approved prompt rules:",
    bundle.promptRules.length > 0
      ? bundle.promptRules.map(formatPromptRule).join("\n")
      : "No applicable prompt rules.",
    "",
    "Knowledge sections:",
    bundle.knowledgeSections.length > 0
      ? bundle.knowledgeSections.map(formatKnowledgeSection).join("\n")
      : "No applicable knowledge sections.",
    "",
    "Similar past failures:",
    bundle.similarFailures.length > 0
      ? bundle.similarFailures.map(formatFailure).join("\n")
      : "No similar failures found.",
  ];

  return trimToBudget(sections.join("\n"), bundle.contextBudgetChars);
};
