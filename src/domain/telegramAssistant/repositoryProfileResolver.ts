import type { RepositoryProfile } from "../../models/types.js";

export interface TelegramExecutionRepositoryProfile {
  repositoryName: string;
  repoPathKey: string;
  baseBranch: string;
  queue: string;
  tags: string[];
}

export interface ResolveTelegramExecutionRepositoryProfileInput {
  repositories: RepositoryProfile[];
  defaultRepository?: string;
  text: string;
}

export type TelegramRepositoryProfileResolution =
  | {
      status: "selected";
      profile: TelegramExecutionRepositoryProfile;
      reason: "single_profile" | "default_repository" | "text_match";
    }
  | { status: "needs_selection"; options: TelegramExecutionRepositoryProfile[] }
  | { status: "unavailable"; reason: "no_profiles" | "profile_missing_queue" };

interface ExecutableRepositoryProfile {
  source: RepositoryProfile;
  execution: TelegramExecutionRepositoryProfile;
}

const toRepoPathKey = (repository: RepositoryProfile): string => repository.name;

const toExecutableProfile = (
  repository: RepositoryProfile,
): ExecutableRepositoryProfile | undefined => {
  const queue = repository.queues[0]?.trim();
  if (!queue) {
    return undefined;
  }

  return {
    source: repository,
    execution: {
      repositoryName: repository.name,
      repoPathKey: toRepoPathKey(repository),
      baseBranch: repository.baseBranch,
      queue,
      tags: [...repository.tags],
    },
  };
};

const normalizeMatchValue = (value: string): string => value.trim().toLowerCase();

const isMatchBoundary = (character: string | undefined): boolean =>
  character === undefined || !/[\p{L}\p{N}]/u.test(character);

const matchesConfiguredValue = (text: string, value: string): boolean => {
  const normalizedValue = normalizeMatchValue(value);
  if (normalizedValue.length === 0) {
    return false;
  }

  let fromIndex = 0;
  while (fromIndex < text.length) {
    const matchIndex = text.indexOf(normalizedValue, fromIndex);
    if (matchIndex === -1) {
      return false;
    }

    const before = matchIndex > 0 ? text[matchIndex - 1] : undefined;
    const afterIndex = matchIndex + normalizedValue.length;
    const after = afterIndex < text.length ? text[afterIndex] : undefined;
    if (isMatchBoundary(before) && isMatchBoundary(after)) {
      return true;
    }

    fromIndex = matchIndex + 1;
  }

  return false;
};

const getProfileMatchValues = (
  profile: ExecutableRepositoryProfile,
): string[] => [
  profile.execution.repositoryName,
  profile.execution.repoPathKey,
  profile.execution.baseBranch,
  profile.execution.queue,
  ...profile.execution.tags,
];

export const resolveTelegramExecutionRepositoryProfile = (
  input: ResolveTelegramExecutionRepositoryProfileInput,
): TelegramRepositoryProfileResolution => {
  const executableProfiles = input.repositories
    .map(toExecutableProfile)
    .filter((profile): profile is ExecutableRepositoryProfile => profile !== undefined);

  if (executableProfiles.length === 0) {
    return {
      status: "unavailable",
      reason: input.repositories.length === 0 ? "no_profiles" : "profile_missing_queue",
    };
  }

  if (executableProfiles.length === 1) {
    const profile = executableProfiles[0];
    if (!profile) {
      return { status: "unavailable", reason: "profile_missing_queue" };
    }

    return {
      status: "selected",
      reason: "single_profile",
      profile: profile.execution,
    };
  }

  const defaultRepository = input.defaultRepository
    ? normalizeMatchValue(input.defaultRepository)
    : undefined;
  const defaultProfile = executableProfiles.find((profile) =>
    defaultRepository !== undefined &&
    [
      profile.execution.repositoryName,
      profile.execution.repoPathKey,
    ].some((value) => normalizeMatchValue(value) === defaultRepository)
  );
  if (defaultProfile) {
    return {
      status: "selected",
      reason: "default_repository",
      profile: defaultProfile.execution,
    };
  }

  const messageText = normalizeMatchValue(input.text);
  if (messageText.length > 0) {
    const matchingProfiles = executableProfiles.filter((profile) =>
      getProfileMatchValues(profile).some((value) =>
        matchesConfiguredValue(messageText, value)
      )
    );

    if (matchingProfiles.length === 1) {
      const profile = matchingProfiles[0];
      if (!profile) {
        return {
          status: "needs_selection",
          options: executableProfiles.map((candidate) => candidate.execution),
        };
      }

      return {
        status: "selected",
        reason: "text_match",
        profile: profile.execution,
      };
    }

    if (matchingProfiles.length > 1) {
      return {
        status: "needs_selection",
        options: matchingProfiles.map((profile) => profile.execution),
      };
    }
  }

  return {
    status: "needs_selection",
    options: executableProfiles.map((profile) => profile.execution),
  };
};
