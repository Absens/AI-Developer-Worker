import { Pool } from "pg";
import { buildRepositoryRuntimeConfig } from "./config.js";
import type { ApplicationRuntime } from "./app.js";
import { InternalWorkerOrchestrator, type InternalExecutionContext } from "./domain/internalWorkerOrchestrator.js";
import { isExecutionInProgress } from "./domain/taskTracker/recovery.js";
import { loadManagedBootstrap } from "./domain/settings/bootstrap.js";
import { ManagedSettingsService } from "./domain/settings/service.js";
import { ManagedRuntime, type ManagedExecutionSnapshot } from "./domain/settings/runtime.js";
import { pinManagedTaskConfiguration } from "./domain/settings/taskSnapshot.js";
import { TokenCipher } from "./domain/settings/tokenCipher.js";
import { PostgresTaskTrackerClient } from "./integrations/internalTracker/postgresTaskTracker.js";
import { runInternalTrackerMigrations } from "./integrations/internalTracker/migrations.js";
import { PostgresSettingsStore } from "./integrations/settings/postgresStore.js";
import { ManagedGitLabGateway } from "./integrations/settings/gitlab.js";
import { ManagedWorkspace } from "./integrations/settings/workspace.js";
import { getCodexShellEnv } from "./integrations/codex/auth.js";
import { CliCodexRunner } from "./integrations/codex/runner.js";
import { RepositoryGitService } from "./integrations/git/service.js";
import { GitLabApiClient } from "./integrations/gitlab/client.js";
import { createObservabilityService } from "./observability/service.js";
import type { AppConfig, RepositoryProfile } from "./models/types.js";
import { checkManagedExecutor } from "./domain/settings/executorReadiness.js";
import { Logger } from "./utils/logger.js";

export const buildManagedApplication = async (env: NodeJS.ProcessEnv = process.env): Promise<ApplicationRuntime & {
  preflight: { run(): Promise<{ name: string; status: "pass" | "warn" | "fail"; details: string }[]> };
}> => {
  const bootstrap = loadManagedBootstrap(env);
  const { fleet } = bootstrap;
  const logger = new Logger();
  const pool = new Pool({ connectionString: bootstrap.databaseUrl, max: 10, connectionTimeoutMillis: 5_000 });
  try { await runInternalTrackerMigrations(pool); }
  catch { await pool.end(); throw new Error("Managed database initialization failed. Check database access and migration status."); }
  const store = new PostgresSettingsStore(pool);
  const tracker = new PostgresTaskTrackerClient(pool, { autonomyPolicy: fleet.autonomy });
  const workspace = new ManagedWorkspace(bootstrap.workspaceRoot);
  const settings = new ManagedSettingsService(store, new TokenCipher(bootstrap.encryptionKey), new ManagedGitLabGateway(bootstrap.allowedOrigins), workspace, bootstrap.allowedOrigins);
  const profiles: RepositoryProfile[] = [];
  const observability = createObservabilityService(fleet.observability, logger, profiles, tracker, undefined, undefined, settings);
  const context = (snapshot: ManagedExecutionSnapshot): InternalExecutionContext => {
    const definition = snapshot.active.definition;
    const profile: RepositoryProfile = {
      name: snapshot.project.id, repoPath: workspace.pathFor(snapshot.project.id), gitlabProjectId: definition.gitlabProjectId,
      gitRemoteName: "origin", gitRepositoryUrl: snapshot.active.cloneUrl, baseBranch: definition.baseBranch,
      queues: ["MANAGED"], tags: ["ai_dev"], testCommand: definition.testCommand, lintCommand: definition.lintCommand,
      buildCommand: definition.buildCommand, typeCheckCommand: definition.typeCheckCommand,
    };
    const config: AppConfig = {
      ...buildRepositoryRuntimeConfig(fleet, profile),
      gitlabUrl: snapshot.connection.origin, gitlabToken: snapshot.connection.token, gitRepositoryToken: snapshot.connection.token,
      codexModel: definition.model || fleet.codex.model, codexTimeoutMs: definition.timeoutSeconds * 1000,
      maxFixAttempts: definition.maxFixAttempts, maxReviewFixAttempts: definition.maxFixAttempts,
    };
    return { profile, config, git: new RepositoryGitService(config, logger), gitlab: new GitLabApiClient(config, logger), codex: new CliCodexRunner(config, logger) };
  };
  const checkExecutor = async (path: string): Promise<void> => {
    const base = await store.read();
    const project = base.projects.find(p => workspace.pathFor(p.id) === path);
    if (!project) throw new Error("Unknown project workspace.");
    const profile: RepositoryProfile = { name: project.id, repoPath: path, gitlabProjectId: project.desired.gitlabProjectId,
      gitRemoteName: "origin", baseBranch: project.desired.baseBranch, queues: ["MANAGED"], tags: ["ai_dev"], testCommand: project.desired.testCommand, lintCommand: project.desired.lintCommand };
    const config = buildRepositoryRuntimeConfig(fleet, profile);
    await checkManagedExecutor({ command: config.codexCliCommand, args: config.codexCliArgs, cwd: path, env: getCodexShellEnv(config) });
  };
  const orchestrator = new ManagedRuntime(settings, fleet.workerId, async snapshot => {
    const ctx = context(snapshot);
    const existing = profiles.findIndex(profile => profile.name === ctx.profile.name);
    if (existing === -1) profiles.push(ctx.profile); else profiles[existing] = ctx.profile;
    const execution = new InternalWorkerOrchestrator(fleet, [ctx], tracker, logger, undefined, observability, [],
      async (_context, task) => context(await pinManagedTaskConfiguration(tracker, task, snapshot, fleet.workerId)));
    await execution.runOnce();
  }, checkExecutor, async id => {
    const tasks = await tracker.listTasks({ repositoryName: id, statuses: ["analyzing", "decomposing", "implementing", "validating", "fixing_review"], limit: 1 });
    const leases = await tracker.listActiveLeases();
    return tasks.some(task => isExecutionInProgress(task.status)) || leases.some(lease => lease.repositoryName === id);
  });
  return {
    config: fleet, logger, observability, orchestrator,
    preflight: { run: async () => [{ name: "managed_registry", status: "pass", details: `${(await store.read()).projects.length} managed projects; unconfigured projects do not block the control interface.` }] },
    cleanup: { start() {}, runOnce: async () => undefined, stop: () => pool.end() },
    telegramAssistant: { start: async () => {}, stop: async () => {} },
    assertRepositoryReady: async () => { await store.read(); },
    // Codex and individual repositories are checked on activation, not at control-plane startup.
    assertCodexAuthenticated: async () => {},
  } as ApplicationRuntime & { preflight: { run(): Promise<{ name: string; status: "pass" | "warn" | "fail"; details: string }[]> } };
};
