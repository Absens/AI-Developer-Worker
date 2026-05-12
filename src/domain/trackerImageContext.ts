import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type {
  TrackerAttachment,
  TrackerClient,
  TrackerImageContextConfig,
} from "../models/types.js";
import { Logger } from "../utils/logger.js";

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export interface PreparedTrackerImageContext {
  imagePaths: string[];
  promptSummary: string;
  skipped: Array<{ name: string; reason: string }>;
  cleanup(): Promise<void>;
}

export interface PrepareTrackerImageContextInput {
  issueKey: string;
  tracker: Pick<TrackerClient, "getIssueAttachments" | "downloadIssueAttachment">;
  config: TrackerImageContextConfig;
  logger: Logger;
}

const sanitizeFileName = (name: string): string => {
  const onlyName = basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
  return onlyName || "attachment";
};

const isSupportedImage = (attachment: TrackerAttachment): boolean =>
  SUPPORTED_IMAGE_MIME_TYPES.has((attachment.mimetype ?? "").toLowerCase());

const formatBytes = (bytes: number | undefined): string =>
  bytes === undefined ? "unknown bytes" : `${bytes} bytes`;

const emptyContext = (): PreparedTrackerImageContext => ({
  imagePaths: [],
  promptSummary: "No Tracker image attachments were available.",
  skipped: [],
  cleanup: async () => {},
});

export const prepareTrackerImageContext = async (
  input: PrepareTrackerImageContextInput,
): Promise<PreparedTrackerImageContext> => {
  if (!input.config.enabled) {
    return {
      ...emptyContext(),
      promptSummary: "Tracker image context is disabled by configuration.",
    };
  }

  if (!input.tracker.getIssueAttachments || !input.tracker.downloadIssueAttachment) {
    return {
      ...emptyContext(),
      promptSummary: "Tracker image context is unavailable for this task source.",
    };
  }

  const attachments = await input.tracker.getIssueAttachments(input.issueKey);
  const skipped: Array<{ name: string; reason: string }> = [];
  const selected: TrackerAttachment[] = [];

  for (const attachment of attachments) {
    if (!isSupportedImage(attachment)) {
      skipped.push({
        name: attachment.name,
        reason: `unsupported mimetype ${attachment.mimetype ?? "unknown"}`,
      });
      continue;
    }

    if (attachment.size !== undefined && attachment.size > input.config.maxBytes) {
      skipped.push({
        name: attachment.name,
        reason: `size ${attachment.size} exceeds limit ${input.config.maxBytes}`,
      });
      continue;
    }

    if (selected.length >= input.config.maxCount) {
      skipped.push({
        name: attachment.name,
        reason: `image count limit ${input.config.maxCount} reached`,
      });
      continue;
    }

    selected.push(attachment);
  }

  if (selected.length === 0) {
    return {
      ...emptyContext(),
      skipped,
      promptSummary:
        skipped.length > 0
          ? [
              "No Tracker image attachments were passed to Codex.",
              "Skipped attachments:",
              ...skipped.map((entry) => `- ${entry.name}: ${entry.reason}`),
            ].join("\n")
          : "No Tracker image attachments were available.",
    };
  }

  const parentDir = input.config.tempDir ?? tmpdir();
  const dir = await mkdtemp(join(parentDir, "tracker-image-context-"));
  const imagePaths: string[] = [];

  try {
    for (const [index, attachment] of selected.entries()) {
      const bytes = await input.tracker.downloadIssueAttachment(input.issueKey, attachment);
      const localPath = join(
        dir,
        `${String(index + 1).padStart(2, "0")}-${sanitizeFileName(attachment.name)}`,
      );
      await writeFile(localPath, bytes);
      imagePaths.push(localPath);
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  const promptSummary = [
    "Tracker image attachments passed to Codex:",
    ...selected.map((attachment, index) =>
      [
        `- Image ${index + 1}: ${attachment.name}`,
        `mimetype=${attachment.mimetype ?? "unknown"}`,
        `size=${formatBytes(attachment.size)}`,
        attachment.metadata?.size ? `dimensions=${attachment.metadata.size}` : undefined,
        attachment.createdAt ? `createdAt=${attachment.createdAt}` : undefined,
      ]
        .filter(Boolean)
        .join(", "),
    ),
    skipped.length > 0 ? "Skipped attachments:" : "",
    ...skipped.map((entry) => `- ${entry.name}: ${entry.reason}`),
  ]
    .filter(Boolean)
    .join("\n");

  input.logger.info("Prepared Tracker image context.", {
    issueKey: input.issueKey,
    imageCount: imagePaths.length,
    skippedCount: skipped.length,
  });

  return {
    imagePaths,
    promptSummary,
    skipped,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};
