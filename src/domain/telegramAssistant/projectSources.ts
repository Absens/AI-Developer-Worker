import type {
  KnowledgeSection,
  RepositoryKnowledgeBase,
  RepositoryProfile,
} from "../../models/types.js";
import { redactSecrets } from "../../observability/redaction.js";
import type { Logger } from "../../utils/logger.js";
import type { MemoryStore } from "../memoryStore.js";
import type {
  ProjectAnalysis,
  ProjectGoal,
  ProjectManagerStore,
} from "../projectManager/index.js";
import type { AssistantSource } from "./assistantCodex.js";

export interface TelegramAssistantProjectSourceInput {
  question: string;
  repositories: RepositoryProfile[];
}

export interface TelegramAssistantProjectSourceProvider {
  collectProjectSources(
    input: TelegramAssistantProjectSourceInput,
  ): Promise<AssistantSource[]>;
}

export interface TelegramAssistantProjectContextSourceProviderOptions {
  projectManager?: Pick<ProjectManagerStore, "listGoals" | "listAnalyses">;
  memoryStore?: Pick<MemoryStore, "loadKnowledge">;
  logger?: Pick<Logger, "warn">;
}

type KnowledgeSectionKey =
  | "architectureMap"
  | "entryPoints"
  | "codePatterns"
  | "testStrategy"
  | "knownPitfalls"
  | "conventions";

const KNOWLEDGE_SECTION_KEYS: KnowledgeSectionKey[] = [
  "architectureMap",
  "entryPoints",
  "codePatterns",
  "testStrategy",
  "knownPitfalls",
  "conventions",
];

const MAX_PROJECT_MANAGER_GOALS = 10;
const MAX_PROJECT_MANAGER_ANALYSES = 5;
const MAX_MEMORY_SECTIONS_PER_REPOSITORY = 12;
const MAX_CONTEXT_SOURCE_CHARS = 8_000;
const MAX_SOURCE_ID_CHARS = 256;

export class TelegramAssistantProjectContextSourceProvider
  implements TelegramAssistantProjectSourceProvider {
  private readonly projectManager?: Pick<
    ProjectManagerStore,
    "listGoals" | "listAnalyses"
  >;
  private readonly memoryStore?: Pick<MemoryStore, "loadKnowledge">;
  private readonly logger?: Pick<Logger, "warn">;

  constructor(options: TelegramAssistantProjectContextSourceProviderOptions) {
    this.projectManager = options.projectManager;
    this.memoryStore = options.memoryStore;
    this.logger = options.logger;
  }

  async collectProjectSources(
    input: TelegramAssistantProjectSourceInput,
  ): Promise<AssistantSource[]> {
    const sources: AssistantSource[] = [];
    const repositoryNames = new Set(
      input.repositories.map((repository) => repository.name),
    );

    const goalSource = await this.collectSafely(
      "Failed to collect Telegram project manager goals.",
      () => this.collectGoalSource(repositoryNames),
    );
    if (goalSource) {
      sources.push(goalSource);
    }

    const analysisSource = await this.collectSafely(
      "Failed to collect Telegram project manager analyses.",
      () => this.collectAnalysisSource(repositoryNames),
    );
    if (analysisSource) {
      sources.push(analysisSource);
    }

    for (const repository of input.repositories) {
      const memorySource = await this.collectSafely(
        "Failed to collect Telegram repository memory.",
        () => this.collectRepositoryMemorySource(repository.name),
        { repositoryName: repository.name },
      );
      if (memorySource) {
        sources.push(memorySource);
      }
    }

    return sources;
  }

  private async collectGoalSource(
    repositoryNames: Set<string>,
  ): Promise<AssistantSource | undefined> {
    if (!this.projectManager) {
      return undefined;
    }

    const goals = (await this.projectManager.listGoals())
      .filter((goal) => isRepositoryScoped(goal.repositoryName, repositoryNames))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_PROJECT_MANAGER_GOALS);
    if (goals.length === 0) {
      return undefined;
    }

    return buildSource(
      "project-manager:goals",
      goals.map(formatProjectGoal).join("\n\n"),
    );
  }

  private async collectAnalysisSource(
    repositoryNames: Set<string>,
  ): Promise<AssistantSource | undefined> {
    if (!this.projectManager) {
      return undefined;
    }

    const analyses = (await this.projectManager.listAnalyses())
      .filter((analysis) => isRepositoryScoped(analysis.repositoryName, repositoryNames))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_PROJECT_MANAGER_ANALYSES);
    if (analyses.length === 0) {
      return undefined;
    }

    return buildSource(
      "project-manager:analyses",
      analyses.map(formatProjectAnalysis).join("\n\n"),
    );
  }

  private async collectRepositoryMemorySource(
    repositoryName: string,
  ): Promise<AssistantSource | undefined> {
    if (!this.memoryStore) {
      return undefined;
    }

    const knowledge = await this.memoryStore.loadKnowledge(repositoryName);
    const sections = collectKnowledgeSections(knowledge)
      .slice(0, MAX_MEMORY_SECTIONS_PER_REPOSITORY);
    if (sections.length === 0) {
      return undefined;
    }

    return buildSource(
      `memory:${repositoryName}:knowledge`,
      [
        `Repository: ${knowledge.repositoryName}`,
        `Updated: ${knowledge.updatedAt}`,
        ...sections.map(formatKnowledgeSection),
      ].join("\n"),
    );
  }

  private async collectSafely(
    message: string,
    operation: () => Promise<AssistantSource | undefined>,
    context: Record<string, unknown> = {},
  ): Promise<AssistantSource | undefined> {
    try {
      return await operation();
    } catch (error) {
      this.logger?.warn(message, redactSecrets({
        ...context,
        error: errorToMessage(error),
      }));
      return undefined;
    }
  }
}

const isRepositoryScoped = (
  repositoryName: string,
  repositoryNames: Set<string>,
): boolean => repositoryNames.size === 0 || repositoryNames.has(repositoryName);

const buildSource = (
  id: string,
  body: string,
): AssistantSource | undefined => {
  const safeBody = redactSecrets(body.trim(), MAX_CONTEXT_SOURCE_CHARS).trim();
  if (!safeBody) {
    return undefined;
  }
  return {
    id: redactSecrets(id, MAX_SOURCE_ID_CHARS),
    body: safeBody,
  };
};

const formatProjectGoal = (goal: ProjectGoal): string =>
  [
    `- ${goal.id} [${goal.status}] ${goal.repositoryName}: ${goal.title}`,
    `  Problem: ${goal.problemStatement}`,
    `  Desired outcome: ${goal.desiredOutcome}`,
    `  Success metrics: ${goal.successMetrics.join("; ") || "none"}`,
    `  Priority: ${goal.priority}; risk: ${goal.riskLevel}; updated: ${goal.updatedAt}`,
  ].join("\n");

const formatProjectAnalysis = (analysis: ProjectAnalysis): string =>
  [
    `- ${analysis.id} [${analysis.analysisKind}] ${analysis.repositoryName}`,
    `  Summary: ${analysis.summary}`,
    `  Health signals: ${analysis.healthSignals
      .map((signal) => signal.title)
      .join("; ") || "none"}`,
    `  Proposed goals: ${analysis.proposedGoals
      .map((goal) => goal.title)
      .join("; ") || "none"}`,
    `  Stale goals: ${analysis.staleGoalIds.join("; ") || "none"}`,
    `  Created: ${analysis.createdAt}`,
  ].join("\n");

const collectKnowledgeSections = (
  knowledge: RepositoryKnowledgeBase,
): Array<{ key: KnowledgeSectionKey; section: KnowledgeSection }> =>
  KNOWLEDGE_SECTION_KEYS.flatMap((key) =>
    knowledge[key].map((section) => ({ key, section })),
  );

const formatKnowledgeSection = (
  entry: { key: KnowledgeSectionKey; section: KnowledgeSection },
): string =>
  [
    `- ${entry.section.title} (${entry.key}; ${entry.section.source}; confidence ${entry.section.confidence})`,
    `  ${entry.section.body}`,
    `  Refs: ${entry.section.sourceRefs.join("; ") || "none"}`,
  ].join("\n");

const errorToMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
