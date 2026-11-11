import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SessionService } from './session.service';
import { ProjectCatalogEntry, ProjectDefinitionDto, RepositoryOptionDto, SettingsViewDto } from '../models/settings.dto';

@Injectable({ providedIn: 'root' })
export class SettingsApiService {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionService);
  private url(path = ''): string { return `${this.session.apiPath()}/settings${path}`; }
  read() { return this.http.get<SettingsViewDto>(this.url()); }
  connect(input: { name: string; origin: string; token: string }, expectedRevision: number) {
    return this.http.post<SettingsViewDto>(this.url('/connections'), { ...input, expectedRevision });
  }
  rotate(id: string, token: string, expectedRevision: number) {
    return this.http.post<SettingsViewDto>(this.url(`/connections/${encodeURIComponent(id)}/rotate`), { token, expectedRevision });
  }
  repositories(id: string, page = 1) {
    return this.http.get<{ repositories: RepositoryOptionDto[]; nextPage: number | null }>(this.url(`/connections/${encodeURIComponent(id)}/repositories?page=${page}`));
  }
  save(id: string | undefined, definition: ProjectDefinitionDto, expectedRevision: number) {
    const body = { definition, expectedRevision };
    return id ? this.http.put<SettingsViewDto>(this.url(`/projects/${encodeURIComponent(id)}`), body)
      : this.http.post<SettingsViewDto>(this.url('/projects'), body);
  }
  enable(id: string, enabled: boolean, expectedRevision: number) {
    return this.http.post<SettingsViewDto>(this.url(`/projects/${encodeURIComponent(id)}/state`), { enabled, expectedRevision });
  }
  catalog() { return this.http.get<{ managed: boolean; projects: ProjectCatalogEntry[] }>(`${this.session.apiPath()}/project-catalog`); }
}
