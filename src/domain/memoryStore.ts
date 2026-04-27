import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  FailureMemoryEntry,
  KnowledgeSection,
  MemoryConfig,
  PromptRule,
  RepositoryKnowledgeBase,
  ReviewLearningEntry,
  TaskType,
} from "../models/types.js";
import { ConfigurationError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { sanitizeRepositoryKey } from "../utils/repositoryKey.js";

export interface MemoryStore {
  ensureRepository(
    repositoryName: string,
    metadata?: { gitlabProjectId?: string },
  ): Promise<void>;
  loadKnowledge(repositoryName: string): Promise<RepositoryKnowledgeBase>;
  saveKnowledge(knowledge: RepositoryKnowledgeBase): Promise<void>;
  appendFailure(entry: FailureMemoryEntry): Promise<void>;
  appendReviewLearning(entry: ReviewLearningEntry): Promise<void>;
  loadPromptRules(repositoryName: string): Promise<PromptRule[]>;
  loadFailures(repositoryName: string): Promise<FailureMemoryEntry[]>;
}

export interface MemoryValidationIssue {
  repositoryName?: string;
  file: string;
  message: string;
}

export interface MemoryValidationResult {
  valid: boolean;
  repositoryCount: number;
  issues: MemoryValidationIssue[];
}

interface RepositoryMetadata {
  repositoryName: string;
  repositoryKey: string;
  schemaVersion: 1;
  updatedAt: string;
  gitlabProjectId?: string;
}

const TASK_TYPES: TaskType[] = [
  "frontend_ui_fix",
  "backend_endpoint",
  "tests_only",
  "refactor",
  "dependency_update",
  "documentation",
  "unknown",
];

const KNOWLEDGE_SECTION_KEYS: Array<keyof Pick<
  RepositoryKnowledgeBase,
  | "architectureMap"
  | "entryPoints"
  | "codePatterns"
  | "testStrategy"
  | "knownPitfalls"
  | "conventions"
>> = [
  "architectureMap",
  "entryPoints",
  "codePatterns",
  "testStrategy",
  "knownPitfalls",
  "conventions",
];

const isTaskType = (value: unknown): value is TaskType =>
  typeof value === "string" && TASK_TYPES.includes(value as TaskType);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value;
};

const requireString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
};

const optionalString = (value: unknown, path: string): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireString(value, path);
};

const requireNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  return value;
};

const requirePercent = (value: unknown, path: string): number => {
  const parsed = requireNumber(value, path);
  if (parsed < 0 || parsed > 100) {
    throw new Error(`${path} must be between 0 and 100.`);
  }
  return parsed;
};

const requireStringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be an array of strings.`);
  }
  return value;
};

const requireTaskTypeArray = (value: unknown, path: string): TaskType[] => {
  if (!Array.isArray(value) || value.some((entry) => !isTaskType(entry))) {
    throw new Error(`${path} must be an array of valid task types.`);
  }
  return value as TaskType[];
};

const defaultKnowledge = (repositoryName: string): RepositoryKnowledgeBase => ({
  repositoryName,
  schemaVersion: 1,
  updatedAt: new Date(0).toISOString(),
  architectureMap: [],
  entryPoints: [],
  codePatterns: [],
  testStrategy: [],
  knownPitfalls: [],
  conventions: [],
});

const defaultMetadata = (
  repositoryName: string,
  metadata: { gitlabProjectId?: string } | undefined,
): RepositoryMetadata => ({
  repositoryName,
  repositoryKey: sanitizeRepositoryKey(repositoryName),
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  ...(metadata?.gitlabProjectId ? { gitlabProjectId: metadata.gitlabProjectId } : {}),
});

const validateKnowledgeSection = (
  value: unknown,
  path: string,
): KnowledgeSection => {
  const raw = requireRecord(value, path);
  const source = requireString(raw.source, `${path}.source`);
  if (
    source !== "repo_docs" &&
    source !== "worker_observation" &&
    source !== "review_learning" &&
    source !== "manual"
  ) {
    throw new Error(`${path}.source must be a valid knowledge source.`);
  }

  return {
    id: requireString(raw.id, `${path}.id`),
    title: requireString(raw.title, `${path}.title`),
    body: requireString(raw.body, `${path}.body`),
    source,
    sourceRefs: requireStringArray(raw.sourceRefs, `${path}.sourceRefs`),
    tags: requireStringArray(raw.tags, `${path}.tags`),
    taskTypes: requireTaskTypeArray(raw.taskTypes, `${path}.taskTypes`),
    confidence: requirePercent(raw.confidence, `${path}.confidence`),
    updatedAt: requireString(raw.updatedAt, `${path}.updatedAt`),
  };
};

export const validateRepositoryKnowledgeBase = (
  value: unknown,
): RepositoryKnowledgeBase => {
  const raw = requireRecord(value, "knowledge");
  if (raw.schemaVersion !== 1) {
    throw new Error("knowledge.schemaVersion must be 1.");
  }

  const result: RepositoryKnowledgeBase = {
    repositoryName: requireString(raw.repositoryName, "knowledge.repositoryName"),
    schemaVersion: 1,
    updatedAt: requireString(raw.updatedAt, "knowledge.updatedAt"),
    architectureMap: [],
    entryPoints: [],
    codePatterns: [],
    testStrategy: [],
    knownPitfalls: [],
    conventions: [],
  };

  for (const key of KNOWLEDGE_SECTION_KEYS) {
    const sections = raw[key];
    if (!Array.isArray(sections)) {
      throw new Error(`knowledge.${key} must be an array.`);
    }
    result[key] = sections.map((entry, index) =>
      validateKnowledgeSection(entry, `knowledge.${key}[${index}]`),
    );
  }

  return result;
};

export const validatePromptRule = (value: unknown, path = "promptRule"): PromptRule => {
  const raw = requireRecord(value, path);
  const approvalState = requireString(raw.approvalState, `${path}.approvalState`);
  if (approvalState !== "draft" && approvalState !== "approved") {
    throw new Error(`${path}.approvalState must be draft or approved.`);
  }

  return {
    id: requireString(raw.id, `${path}.id`),
    repositoryName: requireString(raw.repositoryName, `${path}.repositoryName`),
    title: requireString(raw.title, `${path}.title`),
    instruction: requireString(raw.instruction, `${path}.instruction`),
    taskTypes: requireTaskTypeArray(raw.taskTypes, `${path}.taskTypes`),
    promptProfileIds: requireStringArray(raw.promptProfileIds, `${path}.promptProfileIds`),
    sourceEntryIds: requireStringArray(raw.sourceEntryIds, `${path}.sourceEntryIds`),
    confidence: requirePercent(raw.confidence, `${path}.confidence`),
    approvalState,
    createdAt: requireString(raw.createdAt, `${path}.createdAt`),
    updatedAt: requireString(raw.updatedAt, `${path}.updatedAt`),
  };
};

export const validateFailureMemoryEntry = (
  value: unknown,
  path = "failure",
): FailureMemoryEntry => {
  const raw = requireRecord(value, path);
  return {
    repositoryName: requireString(raw.repositoryName, `${path}.repositoryName`),
    issueKey: requireString(raw.issueKey, `${path}.issueKey`),
    taskType: requireTaskType(raw.taskType, `${path}.taskType`),
    promptProfileId: requireString(raw.promptProfileId, `${path}.promptProfileId`),
    failureKind: requireString(raw.failureKind, `${path}.failureKind`),
    diagnosticSummary: requireString(raw.diagnosticSummary, `${path}.diagnosticSummary`),
    ...(optionalString(raw.resolutionSummary, `${path}.resolutionSummary`)
      ? { resolutionSummary: optionalString(raw.resolutionSummary, `${path}.resolutionSummary`) }
      : {}),
    affectedFiles: requireStringArray(raw.affectedFiles, `${path}.affectedFiles`),
    tags: requireStringArray(raw.tags, `${path}.tags`),
    createdAt: requireString(raw.createdAt, `${path}.createdAt`),
  };
};

export const validateReviewLearningEntry = (
  value: unknown,
  path = "reviewLearning",
): ReviewLearningEntry => {
  const raw = requireRecord(value, path);
  const source = requireString(raw.source, `${path}.source`);
  if (
    source !== "review_discussion" &&
    source !== "merge_diff" &&
    source !== "validation_failure"
  ) {
    throw new Error(`${path}.source must be a valid review learning source.`);
  }
  const approvalState = requireString(raw.approvalState, `${path}.approvalState`);
  if (
    approvalState !== "draft" &&
    approvalState !== "approved" &&
    approvalState !== "rejected"
  ) {
    throw new Error(`${path}.approvalState must be draft, approved, or rejected.`);
  }

  return {
    repositoryName: requireString(raw.repositoryName, `${path}.repositoryName`),
    issueKey: requireString(raw.issueKey, `${path}.issueKey`),
    mergeRequestIid: requireInteger(raw.mergeRequestIid, `${path}.mergeRequestIid`),
    taskType: requireTaskType(raw.taskType, `${path}.taskType`),
    promptProfileId: requireString(raw.promptProfileId, `${path}.promptProfileId`),
    source,
    observation: requireString(raw.observation, `${path}.observation`),
    ...(optionalString(raw.recommendedRule, `${path}.recommendedRule`)
      ? { recommendedRule: optionalString(raw.recommendedRule, `${path}.recommendedRule`) }
      : {}),
    affectedFiles: requireStringArray(raw.affectedFiles, `${path}.affectedFiles`),
    tags: requireStringArray(raw.tags, `${path}.tags`),
    confidence: requirePercent(raw.confidence, `${path}.confidence`),
    approvalState,
    createdAt: requireString(raw.createdAt, `${path}.createdAt`),
  };
};

const requireTaskType = (value: unknown, path: string): TaskType => {
  if (!isTaskType(value)) {
    throw new Error(`${path} must be a valid task type.`);
  }
  return value;
};

const requireInteger = (value: unknown, path: string): number => {
  const parsed = requireNumber(value, path);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${path} must be an integer.`);
  }
  return parsed;
};

const validatePromptRules = (value: unknown): PromptRule[] => {
  if (!Array.isArray(value)) {
    throw new Error("prompt-rules.json must contain an array.");
  }
  return value.map((entry, index) => validatePromptRule(entry, `promptRules[${index}]`));
};

const atomicWriteFile = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const parseJson = (raw: string, file: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} must contain valid JSON. ${(error as Error).message}`);
  }
};

const parseJsonl = <T>(
  raw: string,
  file: string,
  validate: (value: unknown, path: string) => T,
): T[] =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => validate(parseJson(line, `${file}:${index + 1}`), `${file}:${index + 1}`));

export class FileMemoryStore implements MemoryStore {
  private readonly disabledRepositoryKeys = new Set<string>();

  constructor(
    private readonly config: MemoryConfig,
    private readonly logger?: Logger,
  ) {}

  async ensureRepository(
    repositoryName: string,
    metadata?: { gitlabProjectId?: string },
  ): Promise<void> {
    const repositoryDir = this.repositoryDir(repositoryName);
    await mkdir(repositoryDir, { recursive: true });
    await this.writeIfMissing(
      join(repositoryDir, "metadata.json"),
      `${JSON.stringify(defaultMetadata(repositoryName, metadata), null, 2)}\n`,
    );
    await this.writeIfMissing(
      join(repositoryDir, "knowledge.json"),
      `${JSON.stringify(defaultKnowledge(repositoryName), null, 2)}\n`,
    );
    await this.writeIfMissing(join(repositoryDir, "prompt-rules.json"), "[]\n");
    await this.writeIfMissing(join(repositoryDir, "failures.jsonl"), "");
    await this.writeIfMissing(join(repositoryDir, "review-learning.jsonl"), "");
  }

  async loadKnowledge(repositoryName: string): Promise<RepositoryKnowledgeBase> {
    const fallback = defaultKnowledge(repositoryName);
    if (this.isDisabled(repositoryName)) {
      return fallback;
    }

    await this.ensureRepository(repositoryName);
    const path = join(this.repositoryDir(repositoryName), "knowledge.json");
    try {
      const parsed = validateRepositoryKnowledgeBase(parseJson(await readFile(path, "utf8"), path));
      return parsed;
    } catch (error) {
      this.handleInvalidMemory(repositoryName, path, error);
      return fallback;
    }
  }

  async saveKnowledge(knowledge: RepositoryKnowledgeBase): Promise<void> {
    const parsed = validateRepositoryKnowledgeBase(knowledge);
    if (this.isDisabled(parsed.repositoryName)) {
      return;
    }

    await this.ensureRepository(parsed.repositoryName);
    await atomicWriteFile(
      join(this.repositoryDir(parsed.repositoryName), "knowledge.json"),
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
  }

  async appendFailure(entry: FailureMemoryEntry): Promise<void> {
    const parsed = validateFailureMemoryEntry(entry);
    if (this.isDisabled(parsed.repositoryName)) {
      return;
    }

    await this.ensureRepository(parsed.repositoryName);
    await appendFile(
      join(this.repositoryDir(parsed.repositoryName), "failures.jsonl"),
      `${JSON.stringify(parsed)}\n`,
      "utf8",
    );
  }

  async appendReviewLearning(entry: ReviewLearningEntry): Promise<void> {
    const parsed = validateReviewLearningEntry(entry);
    if (this.isDisabled(parsed.repositoryName)) {
      return;
    }

    await this.ensureRepository(parsed.repositoryName);
    await appendFile(
      join(this.repositoryDir(parsed.repositoryName), "review-learning.jsonl"),
      `${JSON.stringify(parsed)}\n`,
      "utf8",
    );
  }

  async loadPromptRules(repositoryName: string): Promise<PromptRule[]> {
    if (this.isDisabled(repositoryName)) {
      return [];
    }

    await this.ensureRepository(repositoryName);
    const path = join(this.repositoryDir(repositoryName), "prompt-rules.json");
    try {
      return validatePromptRules(parseJson(await readFile(path, "utf8"), path));
    } catch (error) {
      this.handleInvalidMemory(repositoryName, path, error);
      return [];
    }
  }

  async loadFailures(repositoryName: string): Promise<FailureMemoryEntry[]> {
    if (this.isDisabled(repositoryName)) {
      return [];
    }

    await this.ensureRepository(repositoryName);
    const path = join(this.repositoryDir(repositoryName), "failures.jsonl");
    try {
      return parseJsonl(
        await readFile(path, "utf8"),
        path,
        validateFailureMemoryEntry,
      );
    } catch (error) {
      this.handleInvalidMemory(repositoryName, path, error);
      return [];
    }
  }

  async validateRepository(repositoryName: string): Promise<MemoryValidationIssue[]> {
    return this.validateRepositoryAt(repositoryName, this.repositoryDir(repositoryName));
  }

  private async validateRepositoryAt(
    repositoryName: string,
    repositoryDir: string,
  ): Promise<MemoryValidationIssue[]> {
    const issues: MemoryValidationIssue[] = [];
    const addIssue = (file: string, error: unknown): void => {
      issues.push({
        repositoryName,
        file,
        message: error instanceof Error ? error.message : String(error),
      });
    };

    await this.validateJsonFile(
      join(repositoryDir, "metadata.json"),
      (value) => this.validateMetadata(value),
      addIssue,
    );
    await this.validateJsonFile(
      join(repositoryDir, "knowledge.json"),
      validateRepositoryKnowledgeBase,
      addIssue,
    );
    const promptRules = await this.validateJsonFile(
      join(repositoryDir, "prompt-rules.json"),
      validatePromptRules,
      addIssue,
    );
    const failures = await this.validateJsonlFile(
      join(repositoryDir, "failures.jsonl"),
      validateFailureMemoryEntry,
      addIssue,
    );
    const reviewLearning = await this.validateJsonlFile(
      join(repositoryDir, "review-learning.jsonl"),
      validateReviewLearningEntry,
      addIssue,
    );

    if (promptRules) {
      this.validatePromptRuleReferences(
        repositoryName,
        join(repositoryDir, "prompt-rules.json"),
        promptRules,
        failures ?? [],
        reviewLearning ?? [],
        issues,
      );
    }

    return issues;
  }

  async validateAll(): Promise<MemoryValidationResult> {
    const repositoriesDir = join(this.config.dir, "repositories");
    if (!(await fileExists(repositoriesDir))) {
      return { valid: true, repositoryCount: 0, issues: [] };
    }

    const entries = await readdir(repositoriesDir, { withFileTypes: true });
    const repositoryKeys = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const issues: MemoryValidationIssue[] = [];
    for (const repositoryKey of repositoryKeys) {
      const repositoryName = await this.repositoryNameFromMetadata(repositoryKey);
      issues.push(
        ...(await this.validateRepositoryAt(
          repositoryName,
          join(repositoriesDir, repositoryKey),
        )),
      );
    }

    return {
      valid: issues.length === 0,
      repositoryCount: repositoryKeys.length,
      issues,
    };
  }

  private repositoryDir(repositoryName: string): string {
    return join(this.config.dir, "repositories", sanitizeRepositoryKey(repositoryName));
  }

  private isDisabled(repositoryName: string): boolean {
    return this.disabledRepositoryKeys.has(sanitizeRepositoryKey(repositoryName));
  }

  private async writeIfMissing(path: string, content: string): Promise<void> {
    if (await fileExists(path)) {
      return;
    }
    try {
      await atomicWriteFile(path, content);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EEXIST") && (await fileExists(path))) {
        return;
      }
      throw error;
    }
  }

  private handleInvalidMemory(
    repositoryName: string,
    file: string,
    error: unknown,
  ): void {
    const message = `Invalid memory file for repository "${repositoryName}" at ${file}: ${
      error instanceof Error ? error.message : String(error)
    }. Run npm run memory:validate and fix or remove the corrupted file.`;
    if (this.config.strict) {
      throw new ConfigurationError(message);
    }

    this.disabledRepositoryKeys.add(sanitizeRepositoryKey(repositoryName));
    this.logger?.warn("Repository memory disabled.", {
      repositoryName,
      file,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private validateMetadata(value: unknown): RepositoryMetadata {
    const raw = requireRecord(value, "metadata");
    if (raw.schemaVersion !== 1) {
      throw new Error("metadata.schemaVersion must be 1.");
    }
    return {
      repositoryName: requireString(raw.repositoryName, "metadata.repositoryName"),
      repositoryKey: requireString(raw.repositoryKey, "metadata.repositoryKey"),
      schemaVersion: 1,
      updatedAt: requireString(raw.updatedAt, "metadata.updatedAt"),
      ...(optionalString(raw.gitlabProjectId, "metadata.gitlabProjectId")
        ? { gitlabProjectId: optionalString(raw.gitlabProjectId, "metadata.gitlabProjectId") }
        : {}),
    };
  }

  private async validateJsonFile<T>(
    path: string,
    validate: (value: unknown) => T,
    addIssue: (file: string, error: unknown) => void,
  ): Promise<T | undefined> {
    if (!(await fileExists(path))) {
      return undefined;
    }

    try {
      return validate(parseJson(await readFile(path, "utf8"), path));
    } catch (error) {
      addIssue(path, error);
      return undefined;
    }
  }

  private async validateJsonlFile<T>(
    path: string,
    validate: (value: unknown, path: string) => T,
    addIssue: (file: string, error: unknown) => void,
  ): Promise<T[] | undefined> {
    if (!(await fileExists(path))) {
      return undefined;
    }

    try {
      return parseJsonl(await readFile(path, "utf8"), path, validate);
    } catch (error) {
      addIssue(path, error);
      return undefined;
    }
  }

  private validatePromptRuleReferences(
    repositoryName: string,
    file: string,
    promptRules: PromptRule[],
    failures: FailureMemoryEntry[],
    reviewLearning: ReviewLearningEntry[],
    issues: MemoryValidationIssue[],
  ): void {
    const ruleIds = new Set<string>();
    for (const rule of promptRules) {
      if (ruleIds.has(rule.id)) {
        issues.push({
          repositoryName,
          file,
          message: `Duplicate prompt rule id: ${rule.id}`,
        });
      }
      ruleIds.add(rule.id);
    }

    const sourceIds = new Set<string>();
    for (const failure of failures) {
      sourceIds.add(`failure:${failure.issueKey}:${failure.createdAt}`);
    }
    for (const entry of reviewLearning) {
      sourceIds.add(
        `review:${entry.issueKey}:${entry.mergeRequestIid}:${entry.createdAt}:${entry.source}`,
      );
    }

    for (const rule of promptRules) {
      for (const sourceEntryId of rule.sourceEntryIds) {
        if (!sourceIds.has(sourceEntryId)) {
          issues.push({
            repositoryName,
            file,
            message: `Prompt rule ${rule.id} references missing source entry ${sourceEntryId}.`,
          });
        }
      }
    }
  }

  private async repositoryNameFromMetadata(repositoryKey: string): Promise<string> {
    const metadataPath = join(this.config.dir, "repositories", repositoryKey, "metadata.json");
    try {
      const metadata = this.validateMetadata(parseJson(await readFile(metadataPath, "utf8"), metadataPath));
      return metadata.repositoryName;
    } catch {
      return repositoryKey;
    }
  }
}
