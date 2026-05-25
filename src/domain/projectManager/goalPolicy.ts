import { createHash } from "node:crypto";

import type { EvidenceRef } from "../taskTracker/types.js";

export interface BuildProjectGoalDuplicateSignatureInput {
  repositoryName: string;
  title: string;
  evidenceRefs: EvidenceRef[];
}

export const normalizeProjectGoalTitle = (title: string): string =>
  title.trim().toLowerCase().replace(/\s+/g, " ");

export const buildProjectGoalDuplicateSignature = (
  input: BuildProjectGoalDuplicateSignatureInput,
): string => {
  const evidenceIdentities = [
    ...new Set(
      input.evidenceRefs.map(
        (evidenceRef) =>
          `${evidenceRef.kind}:${evidenceRef.ref.trim().toLowerCase()}`,
      ),
    ),
  ].sort();

  return createHash("sha256")
    .update(
      JSON.stringify({
        repositoryName: input.repositoryName,
        title: normalizeProjectGoalTitle(input.title),
        evidenceRefs: evidenceIdentities,
      }),
    )
    .digest("hex");
};
