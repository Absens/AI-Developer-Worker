import type {
  GitLabService,
  MergeRequestDiscussion,
  MergeRequestNote,
  ReviewMetadata,
} from "../models/types.js";

export const mergeUniqueStrings = (
  first: readonly string[],
  second: readonly string[],
): string[] => [...new Set([...first, ...second])];

export const mergeUniqueNumbers = (
  first: readonly number[],
  second: readonly number[],
): number[] => [...new Set([...first, ...second])];

export const latestReviewMetadataForMergeRequest = (
  records: readonly { metadata: ReviewMetadata; createdAt: string }[],
  mergeRequestIid: number,
): ReviewMetadata | undefined =>
  records
    .filter((record) => record.metadata.mergeRequestIid === mergeRequestIid)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.metadata;

export const findPendingReviewDiscussions = async (input: {
  gitlab: Pick<GitLabService, "getCurrentUser" | "getMergeRequestDiscussions">;
  mergeRequestIid: number;
  previousMetadata?: ReviewMetadata;
}): Promise<MergeRequestDiscussion[]> => {
  const [currentUser, discussions] = await Promise.all([
    input.gitlab.getCurrentUser(),
    input.gitlab.getMergeRequestDiscussions(input.mergeRequestIid),
  ]);
  const processedDiscussionIds = new Set(
    input.previousMetadata?.processedDiscussionIds ?? [],
  );
  const processedNoteIds = new Set(input.previousMetadata?.processedNoteIds ?? []);

  return discussions
    .filter((discussion) => !discussion.resolved)
    .map((discussion) =>
      filterPendingReviewNotes(
        discussion,
        currentUser.username,
        processedDiscussionIds,
        processedNoteIds,
      ),
    )
    .filter(
      (discussion): discussion is MergeRequestDiscussion =>
        discussion !== undefined && discussion.notes.length > 0,
    );
};

const filterPendingReviewNotes = (
  discussion: MergeRequestDiscussion,
  currentUsername: string,
  processedDiscussionIds: Set<string>,
  processedNoteIds: Set<number>,
): MergeRequestDiscussion | undefined => {
  if (processedDiscussionIds.has(discussion.id) && processedNoteIds.size === 0) {
    return undefined;
  }

  const anchorPosition = discussion.notes.find((note) => note.position)?.position;
  const notes = discussion.notes
    .filter((note) => isPendingReviewerNote(note, currentUsername, processedNoteIds))
    .map((note) =>
      note.position || !anchorPosition
        ? note
        : {
            ...note,
            position: anchorPosition,
          },
    );

  if (notes.length === 0) {
    return undefined;
  }

  return {
    ...discussion,
    notes,
  };
};

const isPendingReviewerNote = (
  note: MergeRequestNote,
  currentUsername: string,
  processedNoteIds: Set<number>,
): boolean =>
  !note.system &&
  note.authorUsername !== currentUsername &&
  !processedNoteIds.has(note.id);

export const mergeReviewMetadata = (input: {
  worker: string;
  issueKey: string;
  mergeRequestIid: number;
  previousMetadata?: ReviewMetadata;
  discussions: readonly MergeRequestDiscussion[];
  lastFixCommit: string;
}): ReviewMetadata => ({
  worker: input.worker,
  issueKey: input.issueKey,
  mergeRequestIid: input.mergeRequestIid,
  processedDiscussionIds: mergeUniqueStrings(
    input.previousMetadata?.processedDiscussionIds ?? [],
    input.discussions.map((discussion) => discussion.id),
  ),
  processedNoteIds: mergeUniqueNumbers(
    input.previousMetadata?.processedNoteIds ?? [],
    input.discussions.flatMap((discussion) => discussion.notes.map((note) => note.id)),
  ),
  lastFixCommit: input.lastFixCommit,
});

export const formatReviewReplyBody = (
  commitSha: string,
  validationSummary: string,
): string =>
  [
    `Applied the review feedback in commit ${commitSha}.`,
    "",
    "Validation:",
    validationSummary,
  ].join("\n");
