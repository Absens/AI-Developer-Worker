import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ManagedGitLabGateway } from "../src/integrations/settings/gitlab.js";
import { ManagedWorkspace } from "../src/integrations/settings/workspace.js";

const origin = "https://gitlab.example.test";
const id = "3d60a22c-0e91-47fb-a5b6-203317881829";
const remote = { id: "42", name: "demo", defaultBranch: "main", cloneUrl: `${origin}/team/demo.git` };
const temporary: string[] = [];
afterEach(async () => { for (const p of temporary.splice(0)) await rm(p, { force: true, recursive: true }); });

it("never follows credential-bearing API redirects", async () => {
  const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(null, { status: 302, headers: { location: "https://evil.test" } }));
  const gateway = new ManagedGitLabGateway([origin], fetcher as typeof fetch);
  await expect(gateway.checkConnection(origin, "secret")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
});

it("validates URLs returned by GitLab rather than trusting repository metadata", async () => {
  const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify([{ id: 42, path_with_namespace: "demo", default_branch: "main", http_url_to_repo: "https://evil.test/exfil.git" }]), { status: 200 }));
  const gateway = new ManagedGitLabGateway([origin], fetcher as typeof fetch);
  await expect(gateway.repositories(origin, "secret")).rejects.toThrow();
});

it("exposes pagination instead of silently dropping additional GitLab projects", async () => {
  const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify([{ id: 42, path_with_namespace: "team/demo", default_branch: "main", http_url_to_repo: remote.cloneUrl }]), { status: 200, headers: { "x-next-page": "2" } }));
  const gateway = new ManagedGitLabGateway([origin], fetcher as typeof fetch);
  expect(await gateway.repositories(origin, "secret")).toMatchObject({ nextPage: 2, repositories: [{ id: "42" }] });
});

it("rejects URL/query/credential and directory traversal workspace input before spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-test-")); temporary.push(root);
  const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const workspace = new ManagedWorkspace(root, run);
  expect(() => workspace.pathFor("../../etc")).toThrow();
  await expect(workspace.prepare(id, { ...remote, cloneUrl: "file:///etc" }, { origin, token: "secret" })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

it("does not traverse symlinks in existing checkout paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-test-")); temporary.push(root);
  const outside = await mkdtemp(join(tmpdir(), "managed-outside-")); temporary.push(outside);
  await symlink(outside, join(root, id));
  const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const workspace = new ManagedWorkspace(root, run);
  await expect(workspace.prepare(id, remote, { origin, token: "secret" })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

it("keeps credentials out of git arguments and never runs repository scripts during prepare", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-test-")); temporary.push(root);
  const run = vi.fn(async (options: any) => {
    if (options.args.includes("clone")) await mkdir(join(root, id, ".git"), { recursive: true });
    return { exitCode: 0, stdout: options.args.includes("get-url") ? remote.cloneUrl : "", stderr: "" };
  });
  const workspace = new ManagedWorkspace(root, run);
  await workspace.prepare(id, remote, { origin, token: "super-secret" });
  expect(run.mock.calls.some(([options]) => options.args.includes("clone"))).toBe(true);
  for (const [options] of run.mock.calls) {
    expect(options.command).toBe("git");
    expect(JSON.stringify(options.args)).not.toContain("super-secret");
    expect(options.timeoutMs).toBeGreaterThan(0);
  }
});
