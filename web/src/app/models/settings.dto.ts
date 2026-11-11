export interface ProjectDefinitionDto {
  name: string; connectionId: string; gitlabProjectId: string; baseBranch: string;
  testCommand: string; lintCommand: string; buildCommand?: string; typeCheckCommand?: string;
  model?: string; timeoutSeconds: number; maxFixAttempts: number;
}
export interface ManagedProjectDto {
  id: string; revision: number; desired: ProjectDefinitionDto; enabled: boolean;
  active?: { revision: number; definition: ProjectDefinitionDto; cloneUrl: string };
  status: 'draft' | 'pending' | 'ready' | 'error' | 'paused'; lastError?: string;
}
export interface SettingsViewDto {
  revision: number;
  allowedOrigins: string[];
  connections: { id: string; name: string; origin: string; revision: number; credentialConfigured: boolean }[];
  projects: ManagedProjectDto[];
  workers: { workerId: string; projectId: string; revision: number; connectionRevision: number; state: string; updatedAt: string; message?: string }[];
}
export interface RepositoryOptionDto { id: string; name: string; defaultBranch: string; cloneUrl: string; }
export interface ProjectCatalogEntry { id: string; name: string; repositoryName: string; repoPathKey: string; baseBranch: string; queue: string; tags: string[]; }
