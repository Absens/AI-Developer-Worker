import type {
  DependencyUnknownStatusPolicy,
  LogicalStatus,
  TrackerClient,
  TrackerIssue,
  TrackerIssueLink,
} from "../models/types.js";

export interface DependencyCheckResult {
  eligible: boolean;
  blockers: Array<{
    issueKey: string;
    status?: LogicalStatus;
    reason: string;
  }>;
}

const normalize = (value: string): string => value.trim().toLowerCase();

const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

const blockerKeysFromLinks = (
  links: TrackerIssueLink[],
  blockedByLinkType: string,
): string[] => {
  const normalizedBlockedBy = normalize(blockedByLinkType);
  return links
    .filter((link) => normalize(link.linkType) === normalizedBlockedBy)
    .map((link) => link.targetIssueKey);
};

export const resolveBlockerKeys = async (
  tracker: TrackerClient,
  issue: TrackerIssue,
  blockedByLinkType: string,
): Promise<string[]> => {
  const fieldBlockers = issue.blockedBy ?? [];
  if (!tracker.getIssueLinks) {
    return unique(fieldBlockers);
  }

  let links: TrackerIssueLink[];
  try {
    links = await tracker.getIssueLinks(issue.key);
  } catch {
    return unique(fieldBlockers);
  }
  return unique([...fieldBlockers, ...blockerKeysFromLinks(links, blockedByLinkType)]);
};

export const checkIssueDependencies = async (
  tracker: TrackerClient,
  issue: TrackerIssue,
  options: {
    enforcement: boolean;
    unknownStatusPolicy: DependencyUnknownStatusPolicy;
    blockedByLinkType: string;
  },
): Promise<DependencyCheckResult> => {
  if (!options.enforcement) {
    return { eligible: true, blockers: [] };
  }

  const blockerKeys = await resolveBlockerKeys(
    tracker,
    issue,
    options.blockedByLinkType,
  );
  if (blockerKeys.length === 0) {
    return { eligible: true, blockers: [] };
  }

  const blockers: DependencyCheckResult["blockers"] = [];
  for (const blockerKey of blockerKeys) {
    try {
      const blocker = await tracker.getIssue(blockerKey);
      const status = blocker.logicalStatus ?? tracker.determineLogicalStatus(blocker);
      if (status !== "done") {
        blockers.push({
          issueKey: blockerKey,
          ...(status ? { status } : {}),
          reason: status
            ? `Dependency ${blockerKey} is ${status}.`
            : `Dependency ${blockerKey} status is unknown.`,
        });
      }
    } catch (error) {
      if (options.unknownStatusPolicy === "ignore") {
        continue;
      }
      blockers.push({
        issueKey: blockerKey,
        reason: `Dependency ${blockerKey} could not be loaded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  if (options.unknownStatusPolicy === "warn") {
    const onlyUnknown = blockers.every((blocker) => blocker.status === undefined);
    if (onlyUnknown) {
      return { eligible: true, blockers };
    }
  }

  return {
    eligible: blockers.length === 0,
    blockers,
  };
};
