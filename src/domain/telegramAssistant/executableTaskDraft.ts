import type { TelegramExecutionRepositoryProfile } from "./repositoryProfileResolver.js";
import { classifyTelegramTaskRisk } from "./riskClassifier.js";
import type {
  TelegramExecutableTaskDraft,
  TelegramExecutableTaskDraftQuestion,
} from "./types.js";

export interface BuildTelegramExecutableTaskDraftInput {
  text: string;
  selectedProfile?: TelegramExecutionRepositoryProfile;
  forceOwnerApproval?: boolean;
}

const DEFAULT_TITLE = "Задача из Telegram";
const DEFAULT_ACCEPTANCE_CRITERIA =
  "Поведение реализовано и покрыто существующими проверками.";
const MAX_TITLE_LENGTH = 80;

const TASK_VERB_PREFIX_PATTERN =
  /^(?:\s*(?:надо\s+сделать|создай\s+задачу|заведи\s+задачу|сделай|почини|добавь)[:,\s-]*)+/iu;

const stripTaskCommandPrefix = (text: string): string =>
  text.replace(TASK_VERB_PREFIX_PATTERN, "").trim();

const toTitle = (taskBody: string): string => {
  const title = taskBody.length > 0 ? taskBody : DEFAULT_TITLE;

  if (title.length <= MAX_TITLE_LENGTH) {
    return title;
  }

  return `${title.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`;
};

const uniqueTags = (tags: string[]): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalizedTag = tag.trim();
    if (normalizedTag.length === 0 || seen.has(normalizedTag)) {
      continue;
    }

    seen.add(normalizedTag);
    result.push(normalizedTag);
  }

  return result;
};

export const buildTelegramExecutableTaskDraft = (
  input: BuildTelegramExecutableTaskDraftInput,
): TelegramExecutableTaskDraft => {
  const taskBody = stripTaskCommandPrefix(input.text);
  const risk = classifyTelegramTaskRisk(input.text);
  const executionMode =
    risk.riskLevel === "high" || input.forceOwnerApproval === true
      ? "owner_approval"
      : "auto_ready";

  return {
    title: toTitle(taskBody),
    description: input.text,
    acceptanceCriteria: [DEFAULT_ACCEPTANCE_CRITERIA],
    ...(input.selectedProfile
      ? {
          repositoryName: input.selectedProfile.repositoryName,
          repoPathKey: input.selectedProfile.repoPathKey,
          baseBranch: input.selectedProfile.baseBranch,
          queue: input.selectedProfile.queue,
        }
      : {}),
    tags: uniqueTags([
      "telegram",
      ...(input.selectedProfile?.tags ?? []),
      `risk_${risk.riskLevel}`,
    ]),
    risk,
    executionMode,
  };
};

export const nextExecutableDraftQuestion = (
  draft: TelegramExecutableTaskDraft,
): TelegramExecutableTaskDraftQuestion | undefined => {
  if (
    !draft.repositoryName?.trim() ||
    !draft.repoPathKey?.trim() ||
    !draft.baseBranch?.trim() ||
    !draft.queue?.trim()
  ) {
    return {
      field: "repositoryProfile",
      text: "В каком репозитории выполнить задачу?",
    };
  }

  if (draft.acceptanceCriteria.every((criterion) => criterion.trim().length === 0)) {
    return {
      field: "acceptanceCriteria",
      text: "Как понять, что задача выполнена? Назови 1-3 критерия приемки.",
    };
  }

  const taskBody = draft.title === DEFAULT_TITLE ? "" : draft.title.trim();
  if (taskBody.length < 12) {
    return {
      field: "description",
      text: "Опиши задачу чуть подробнее: что нужно изменить и где это проверить?",
    };
  }

  return undefined;
};
