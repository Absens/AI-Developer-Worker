import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareTrackerImageContext } from "../src/domain/trackerImageContext.js";
import type { TrackerAttachment } from "../src/models/types.js";
import { Logger } from "../src/utils/logger.js";

const cleanupPaths: string[] = [];

const createTempDir = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
};

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("prepareTrackerImageContext", () => {
  it("downloads supported images and summarizes skipped attachments", async () => {
    const tempDir = createTempDir("tracker-image-context-test-");
    const repoDir = join(tempDir, "repo");
    const downloads: string[] = [];
    const attachments: TrackerAttachment[] = [
      {
        id: "img-1",
        name: "../screen one.png",
        mimetype: "image/png",
        size: 512,
        metadata: { size: "1280x720" },
      },
      {
        id: "doc-1",
        name: "notes.pdf",
        mimetype: "application/pdf",
        size: 128,
      },
      {
        id: "img-2",
        name: "large.jpg",
        mimetype: "image/jpeg",
        size: 2048,
      },
    ];

    const context = await prepareTrackerImageContext({
      issueKey: "DEV-1",
      tracker: {
        getIssueAttachments: async () => attachments,
        downloadIssueAttachment: async (_issueKey, attachment) => {
          downloads.push(attachment.id);
          return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        },
      },
      config: {
        enabled: true,
        maxCount: 2,
        maxBytes: 1024,
        tempDir,
      },
      logger: new Logger(),
    });

    expect(downloads).toEqual(["img-1"]);
    expect(context.imagePaths).toHaveLength(1);
    expect(context.imagePaths[0]).toContain(tempDir);
    expect(context.imagePaths[0]).not.toContain(repoDir);
    expect(basename(context.imagePaths[0]!)).toBe("01-screen_one.png");
    expect(readFileSync(context.imagePaths[0]!)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(context.promptSummary).toContain("screen one.png");
    expect(context.promptSummary).toContain("image/png");
    expect(context.promptSummary).toContain("1280x720");
    expect(context.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "notes.pdf",
          reason: "unsupported mimetype application/pdf",
        }),
        expect.objectContaining({
          name: "large.jpg",
          reason: "size 2048 exceeds limit 1024",
        }),
      ]),
    );

    const imageDir = dirname(context.imagePaths[0]!);
    expect(existsSync(imageDir)).toBe(true);
    await context.cleanup();
    expect(existsSync(imageDir)).toBe(false);
  });

  it("limits downloaded images to the configured max count", async () => {
    const tempDir = createTempDir("tracker-image-context-limit-test-");
    const downloads: string[] = [];
    const attachments: TrackerAttachment[] = [
      { id: "img-1", name: "one.png", mimetype: "image/png", size: 1 },
      { id: "img-2", name: "two.webp", mimetype: "image/webp", size: 1 },
      { id: "img-3", name: "three.gif", mimetype: "image/gif", size: 1 },
    ];

    const context = await prepareTrackerImageContext({
      issueKey: "DEV-1",
      tracker: {
        getIssueAttachments: async () => attachments,
        downloadIssueAttachment: async (_issueKey, attachment) => {
          downloads.push(attachment.id);
          return new Uint8Array([attachment.id.charCodeAt(4)]);
        },
      },
      config: {
        enabled: true,
        maxCount: 2,
        maxBytes: 1024,
        tempDir,
      },
      logger: new Logger(),
    });

    expect(downloads).toEqual(["img-1", "img-2"]);
    expect(context.imagePaths).toHaveLength(2);
    expect(context.skipped).toEqual([
      { name: "three.gif", reason: "image count limit 2 reached" },
    ]);

    await context.cleanup();
  });
});
