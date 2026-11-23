import { describe, expect, it, vi } from "vitest";
import { TokenCipher } from "../src/domain/settings/tokenCipher.js";
import { MemorySettingsStore } from "../src/domain/settings/store.js";
import { ManagedSettingsService } from "../src/domain/settings/service.js";
import { validateDefinition, validateOrigin } from "../src/domain/settings/validation.js";

const key = Buffer.alloc(32, 7).toString("base64");
const token = "super-secret-gitlab-token";
const definition = {
  name: "Первый проект", connectionId: "connection", gitlabProjectId: "42",
  baseBranch: "main", testCommand: "npm test", lintCommand: "npm run lint",
  timeoutSeconds: 600, maxFixAttempts: 2,
};
const fixture = () => {
  const store = new MemorySettingsStore();
  const gateway = { checkConnection: vi.fn(async () => {}), repositories: vi.fn(async () => ({ repositories: [], nextPage: null })),
    project: vi.fn(async () => ({ id: "42", name: "Demo", cloneUrl: "https://gitlab.example.test/team/demo.git", defaultBranch: "main" })) };
  const workspace = { prepare: vi.fn(async () => {}), pathFor: (id: string) => `/safe/${id}` };
  const service = new ManagedSettingsService(store, new TokenCipher(key), gateway, workspace, ["https://gitlab.example.test"]);
  return { store, gateway, workspace, service };
};

it("encrypts with authenticated per-record encryption and rejects tampering/wrong identity", () => {
  const cipher = new TokenCipher(key);
  const a = cipher.seal(token, "one"); const b = cipher.seal(token, "one");
  expect(a).not.toContain(token); expect(a).not.toBe(b);
  expect(cipher.open(a, "one")).toBe(token);
  expect(() => cipher.open(a, "two")).toThrow();
  expect(() => new TokenCipher("short")).toThrow();
  expect(() => cipher.open(a.slice(0, -4) + "AAAA", "one")).toThrow();
});

it.each(["http://gitlab.example.test", "https://evil.test", "https://user:pass@gitlab.example.test", "https://gitlab.example.test/path", "https://gitlab.example.test?secret=yes"])("rejects unapproved GitLab origin %s", (origin) => {
  expect(() => validateOrigin(origin, ["https://gitlab.example.test"])).toThrow();
});

it.each(["main;echo bad", "-x", "main$(whoami)", "../outside", "feature/../x", "main\nfoo"])("rejects unsafe branch %s", (baseBranch) => {
  expect(() => validateDefinition({ ...definition, baseBranch })).toThrow();
});

it("validates required checks instead of accepting whitespace and arbitrary workspace paths", () => {
  expect(() => validateDefinition({ ...definition, lintCommand: "  " })).toThrow();
  expect(() => validateDefinition({ ...definition, repoPath: "/etc" })).toThrow();
  expect(validateDefinition(definition).baseBranch).toBe("main");
});

describe("optional project quality gates and review settings", () => {
  it("normalizes commands and preserves zero and fractional numeric values", () => {
    const settings = {
      securityScanCommand: "npm run scan",
      sastCommand: "npm run sast",
      coverageCommand: "npm run coverage",
      visualRegressionCommand: "npm run visual",
      coverageReportFile: "coverage/summary.json",
      minCoveragePercent: 82.5,
      maxReviewFixAttempts: 0,
    };
    expect(validateDefinition({ ...definition, ...settings, coverageCommand: " npm run coverage " }))
      .toEqual({ ...definition, ...settings });
    expect(validateDefinition({ ...definition, coverageCommand: "coverage", minCoveragePercent: 0 }))
      .toHaveProperty("minCoveragePercent", 0);
    expect(validateDefinition({ ...definition, coverageCommand: "coverage", minCoveragePercent: 100 }))
      .toHaveProperty("minCoveragePercent", 100);
  });

  it("leaves legacy definitions unchanged and omits blank optional values", () => {
    expect(validateDefinition(definition)).toEqual(definition);
    expect(validateDefinition({
      ...definition,
      securityScanCommand: " ", sastCommand: "", coverageCommand: "", coverageReportFile: "",
      visualRegressionCommand: "", minCoveragePercent: null, maxReviewFixAttempts: null,
    })).toEqual(definition);
  });

  it.each([NaN, Infinity, -0.01, 100.01, "80", true])("rejects invalid coverage threshold %s", minCoveragePercent => {
    expect(() => validateDefinition({ ...definition, coverageCommand: "coverage", minCoveragePercent }))
      .toThrow("Минимальное покрытие");
  });

  it.each([-1, 1.5, 6, "0", false])("rejects invalid review attempt limit %s", maxReviewFixAttempts => {
    expect(() => validateDefinition({ ...definition, maxReviewFixAttempts })).toThrow("Значение лимита");
  });

  it("requires a coverage command for a report or threshold, including a threshold of zero", () => {
    expect(() => validateDefinition({ ...definition, coverageReportFile: "coverage/summary.json" }))
      .toThrow("Укажите команду");
    expect(() => validateDefinition({ ...definition, coverageCommand: " ", minCoveragePercent: 0 }))
      .toThrow("Укажите команду");
  });

  it.each([
    "/tmp/coverage.json", "C:/coverage.json", "C:coverage.json", "coverage\\summary.json",
    "../coverage.json", "coverage/../summary.json", "coverage/./summary.json", "./coverage.json",
    "coverage//summary.json", "coverage/", ".", "coverage:summary.json",
  ])("rejects a noncanonical report path %s", coverageReportFile => {
    expect(() => validateDefinition({ ...definition, coverageCommand: "coverage", coverageReportFile }))
      .toThrow("относительный путь");
  });
});

it("boots with no connections/projects and never serializes stored tokens", async () => {
  const f = fixture();
  expect((await f.service.view()).projects).toEqual([]);
  await f.service.addConnection({ name: "GitLab", origin: "https://gitlab.example.test", token }, 0, "admin");
  const view = await f.service.view();
  expect(view.connections).toHaveLength(1);
  expect(JSON.stringify(view)).not.toContain(token);
  expect(JSON.stringify(view)).not.toContain("encryptedToken");
  expect((await f.store.read()).connections[0]?.encryptedToken).not.toContain(token);
});

it("checks a new token before replacing working credentials", async () => {
  const f = fixture();
  await f.service.addConnection({ name: "GitLab", origin: "https://gitlab.example.test", token }, 0, "admin");
  const before = await f.store.read(); const id = before.connections[0]!.id;
  f.gateway.checkConnection.mockRejectedValue(new Error(`network error ${token}`));
  await expect(f.service.rotateConnection(id, "another-secret", 1, "admin")).rejects.toThrow("проверить");
  expect(await f.store.read()).toEqual(before);
});

it("rejects stale settings writes and records only redacted audit metadata", async () => {
  const f = fixture();
  await f.service.addConnection({ name: "GitLab", origin: "https://gitlab.example.test", token }, 0, "admin");
  await expect(f.service.addConnection({ name: "Other", origin: "https://gitlab.example.test", token }, 0, "admin")).rejects.toMatchObject({ status: 409 });
  expect((await f.store.read()).connections).toHaveLength(1);
  expect(JSON.stringify(f.store.audit)).not.toContain(token);
});

const createProject = async (f: ReturnType<typeof fixture>) => {
  await f.service.addConnection({ name: "GitLab", origin: "https://gitlab.example.test", token }, 0, "admin");
  const connectionId = (await f.store.read()).connections[0]!.id;
  await f.service.saveProject(undefined, { ...definition, connectionId }, 1, "admin");
  return (await f.store.read()).projects[0]!;
};

it("saves disabled projects, then prepares and activates the requested revision", async () => {
  const f = fixture(); const p = await createProject(f);
  expect(p.enabled).toBe(false); expect(p.active).toBeUndefined();
  await f.service.setEnabled(p.id, true, 2, "admin");
  expect((await f.service.view()).projects[0]?.status).toBe("pending");
  await f.service.applyPending(p.id);
  const active = (await f.store.read()).projects[0]!;
  expect(active.active?.revision).toBe(1); expect(active.status).toBe("ready");
  expect(f.workspace.prepare).toHaveBeenCalledTimes(1);
});

it("does not replace the last active revision when preparation fails", async () => {
  const f = fixture(); const p = await createProject(f);
  await f.service.setEnabled(p.id, true, 2, "admin"); await f.service.applyPending(p.id);
  const before = await f.store.read();
  await f.service.saveProject(p.id, { ...before.projects[0]!.desired, name: "Updated", testCommand: "npm test -- --run" }, before.revision, "admin");
  f.workspace.prepare.mockRejectedValue(new Error(`failed command exposed ${token}`));
  await f.service.applyPending(p.id);
  const result = (await f.service.view()).projects[0]!;
  expect(result.status).toBe("error"); expect(result.active?.revision).toBe(1);
  expect(result.revision).toBe(2); expect(JSON.stringify(result)).not.toContain(token);
});

it("keeps stable project identity and forbids retargeting an existing checkout", async () => {
  const f = fixture(); const p = await createProject(f);
  await f.service.saveProject(p.id, { ...p.desired, name: "Новое имя" }, 2, "admin");
  expect((await f.store.read()).projects[0]?.id).toBe(p.id);
  await expect(f.service.saveProject(p.id, { ...p.desired, gitlabProjectId: "43" }, 3, "admin")).rejects.toThrow();
});

it("serializes preparation/execution per project, not across unrelated projects", async () => {
  const f = fixture(); let release!: () => void;
  const first = f.store.withProjectLock("one", () => new Promise<void>(r => { release = r; }));
  await Promise.resolve();
  expect((await f.store.withProjectLock("one", async () => {})).acquired).toBe(false);
  expect((await f.store.withProjectLock("two", async () => {})).acquired).toBe(true);
  release(); await first;
});
it("preserves credentials when a replacement token cannot read an active project", async () => {
  const f = fixture(); const p = await createProject(f);
  await f.service.setEnabled(p.id, true, 2, "admin"); await f.service.applyPending(p.id);
  const before = await f.store.read();
  f.gateway.project.mockRejectedValue(new Error("project access denied"));
  await expect(f.service.rotateConnection(p.desired.connectionId, "replacement-token", before.revision, "admin")).rejects.toThrow();
  expect(await f.store.read()).toEqual(before);
});
it("does not apply a stale candidate when settings change during checkout validation", async () => {
  const f = fixture(); const p = await createProject(f);
  await f.service.setEnabled(p.id, true, 2, "admin");
  f.workspace.prepare.mockImplementation(async () => {
    const before = await f.store.read();
    await f.service.saveProject(p.id, { ...before.projects[0]!.desired, baseBranch: "develop" }, before.revision, "admin");
  });
  await f.service.applyPending(p.id);
  const project = (await f.store.read()).projects[0]!;
  expect(project.status).toBe("pending"); expect(project.active).toBeUndefined();
});
