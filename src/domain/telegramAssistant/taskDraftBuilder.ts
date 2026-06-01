import type { RepositoryProfile } from "../../models/types.js";

export interface TelegramTaskDraft {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  repositoryName?: string;
  tags: string[];
}

export const buildHeuristicTaskDraft = (
  text: string,
  repositories: RepositoryProfile[],
  defaultRepository?: string,
): TelegramTaskDraft => {
  const cleaned = text
    .replace(/^(надо сделать|создай задачу|заведи задачу|сделай)\s*:?\s*/i, "")
    .trim();
  const repositoryName =
    defaultRepository &&
    repositories.some((repository) => repository.name === defaultRepository)
      ? defaultRepository
      : repositories[0]?.name;

  return {
    title:
      cleaned.length > 80
        ? `${cleaned.slice(0, 77)}...`
        : cleaned || "Задача из Telegram",
    description: text,
    acceptanceCriteria: [
      "Поведение реализовано и покрыто существующими проверками.",
    ],
    ...(repositoryName ? { repositoryName } : {}),
    tags: ["telegram"],
  };
};
