/** Persistent records. Only the service's explicit DTO projection may leave the server. */
export interface ManagedConnection {
  id: string;
  name: string;
  origin: string;
  encryptedToken: string;
  revision: number;
}
export interface ProjectDefinition {
  name: string;
  connectionId: string;
  gitlabProjectId: string;
  baseBranch: string;
  testCommand: string;
  lintCommand: string;
  buildCommand?: string;
  typeCheckCommand?: string;
  model?: string;
  timeoutSeconds: number;
  maxFixAttempts: number;
}
export interface ActiveProject {
  revision: number;
  definition: ProjectDefinition;
  cloneUrl: string;
}
export interface ManagedProject {
  id: string;
  revision: number;
  desired: ProjectDefinition;
  enabled: boolean;
  active?: ActiveProject;
  status: "draft" | "pending" | "ready" | "error" | "paused";
  lastError?: string;
}
export interface SettingsDocument {
  revision: number;
  connections: ManagedConnection[];
  projects: ManagedProject[];
}
export interface AppliedWorkerState {
  workerId: string;
  projectId: string;
  revision: number;
  connectionRevision: number;
  state: "ready" | "running" | "error" | "paused";
  updatedAt: string;
  message?: string;
}
export interface SettingsStore {
  read(): Promise<SettingsDocument>;
  change(expectedRevision: number | undefined, actor: string, action: string,
    mutate: (document: SettingsDocument) => void): Promise<SettingsDocument>;
  withProjectLock<T>(id: string, run: () => Promise<T>): Promise<{ acquired: boolean; result?: T }>;
  recordWorker(state: AppliedWorkerState): Promise<void>;
  workers(): Promise<AppliedWorkerState[]>;
}
export interface GitLabRepository {
  id: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string;
}
export interface SettingsGateway {
  checkConnection(origin: string, token: string): Promise<void>;
  repositories(origin: string, token: string, page?: number): Promise<{ repositories: GitLabRepository[]; nextPage: number | null }>;
  project(origin: string, token: string, id: string, branch: string): Promise<GitLabRepository>;
}
export interface SettingsWorkspace {
  pathFor(id: string): string;
  prepare(id: string, remote: GitLabRepository, connection: { origin: string; token: string }): Promise<void>;
}
export class SettingsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SettingsError";
  }
}
