import type { TaskFieldGroup, TaskFieldOwner } from "./types.js";

export interface FieldOwnershipRule {
  group: TaskFieldGroup;
  owner: TaskFieldOwner;
  owns: string[];
  mustNotOwn: string[];
}

export class FieldOwnershipError extends Error {
  constructor(
    readonly owner: TaskFieldOwner,
    readonly group: TaskFieldGroup,
  ) {
    super(`Owner ${owner} cannot update field group ${group}.`);
  }
}

export const FIELD_OWNERSHIP_RULES: readonly FieldOwnershipRule[] = [
  {
    group: "human_input",
    owner: "human",
    owns: [
      "title",
      "description",
      "acceptanceCriteria",
      "constraints",
      "comments",
      "manualCommands",
    ],
    mustNotOwn: ["leases", "agentRuns", "validationInternals"],
  },
  {
    group: "external_snapshot",
    owner: "external_source",
    owns: [
      "importedSnapshots",
      "externalRevisionMetadata",
      "externalRefs",
      "businessStatusMirror",
    ],
    mustNotOwn: ["internalRuntimeStatus", "leases", "activePlans", "workerDecisions"],
  },
  {
    group: "worker_runtime",
    owner: "worker_agent",
    owns: [
      "executionStatusTransitions",
      "planSteps",
      "agentRuns",
      "questions",
      "decisions",
      "validationRecords",
      "mergeRequestPublicationEvents",
    ],
    mustNotOwn: ["approvedHumanInputRevisions"],
  },
  {
    group: "gitlab_sync",
    owner: "gitlab_sync",
    owns: [
      "mergeRequestRefs",
      "branchMetadata",
      "reviewFeedbackSnapshots",
      "reviewFixState",
    ],
    mustNotOwn: ["canonicalTaskDescription", "externalTrackerStatusPolicy"],
  },
  {
    group: "policy_admin",
    owner: "policy_admin",
    owns: [
      "autonomyLevel",
      "approvalPolicy",
      "supervisorDecisions",
      "retentionSettings",
      "adminSettings",
    ],
    mustNotOwn: ["rawHumanTaskText", "workerExecutionArtifacts"],
  },
];

const HUMAN_REVISION_OWNERS = new Set<TaskFieldOwner>(["human", "external_source"]);

export const canOwnerUpdateFieldGroup = (
  owner: TaskFieldOwner,
  group: TaskFieldGroup,
): boolean => {
  if (group === "human_input") {
    return HUMAN_REVISION_OWNERS.has(owner);
  }

  return FIELD_OWNERSHIP_RULES.some(
    (rule) => rule.owner === owner && rule.group === group,
  );
};

export const assertOwnerCanUpdateFieldGroup = (
  owner: TaskFieldOwner,
  group: TaskFieldGroup,
): void => {
  if (!canOwnerUpdateFieldGroup(owner, group)) {
    throw new FieldOwnershipError(owner, group);
  }
};
