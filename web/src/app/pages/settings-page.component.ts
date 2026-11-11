import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { Observable } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ManagedProjectDto, ProjectDefinitionDto, RepositoryOptionDto, SettingsViewDto } from '../models/settings.dto';
import { SettingsApiService } from '../services/settings-api.service';

@Component({
  selector: 'app-settings-page',
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, InputTextModule, MessageModule, TagModule],
  templateUrl: './settings-page.component.html',
  styles: [`
    .settings-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:1rem; }
    .settings-panel { padding:1.25rem; margin-bottom:1rem; }
    .settings-panel h2 { margin-top:0; }
    .field { display:flex; flex-direction:column; gap:.4rem; margin-bottom:.9rem; }
    .field input,.field select { width:100%; box-sizing:border-box; }
    .field select { padding:.7rem; border:1px solid var(--p-inputtext-border-color); border-radius:var(--p-border-radius-md); background:var(--p-inputtext-background); color:var(--p-inputtext-color); }
    .settings-actions { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; margin-top:.9rem; }
    .project-top { display:flex; justify-content:space-between; align-items:center; gap:1rem; }
    .muted { color:var(--p-text-muted-color); } .hint { line-height:1.5; } code { overflow-wrap:anywhere; }
    .full { grid-column:1/-1; } .worker-row { font-size:.9rem; margin-top:.5rem; }
  `],
})
export class SettingsPageComponent implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly destroy = inject(DestroyRef);
  readonly view = signal<SettingsViewDto | undefined>(undefined);
  readonly error = signal(''); readonly notice = signal(''); readonly busy = signal(false);
  readonly repositories = signal<RepositoryOptionDto[]>([]); readonly nextPage = signal<number | null>(null);
  readonly editing = signal(false); readonly rotating = signal<string | undefined>(undefined);
  connection = { name: '', origin: '', token: '' };
  rotationToken = '';
  project: ProjectDefinitionDto = this.emptyProject();
  projectId: string | undefined;
  private editRevision = 0;
  private rotationRevision = 0;
  private refreshing = false;

  ngOnInit(): void {
    this.refresh();
    const timer = setInterval(() => { if (!this.editing() && !this.rotating() && !this.busy()) this.refresh(false); }, 5000);
    this.destroy.onDestroy(() => { clearInterval(timer); this.connection.token = ''; this.rotationToken = ''; });
  }
  private emptyProject(): ProjectDefinitionDto {
    return { name: '', connectionId: '', gitlabProjectId: '', baseBranch: 'main', testCommand: 'npm test', lintCommand: 'npm run lint', buildCommand: '', typeCheckCommand: '', model: '', timeoutSeconds: 1800, maxFixAttempts: 2 };
  }
  refresh(clear = true): void {
    if (this.refreshing) return;
    this.refreshing = true;
    if (clear) this.error.set('');
    this.api.read().pipe(takeUntilDestroyed(this.destroy)).subscribe({ next: view => {
      this.view.set(view); this.refreshing = false;
      if (!this.connection.origin) this.connection.origin = view.allowedOrigins[0] ?? '';
    }, error: error => { this.refreshing = false; this.showError(error); } });
  }
  connect(): void {
    const view = this.view(); if (!view || this.busy()) return;
    const request = this.api.connect(this.connection, view.revision);
    this.connection = { ...this.connection, token: '' };
    this.mutate(request, 'Подключение проверено и сохранено.');
  }
  beginRotation(id: string): void { this.rotationRevision = this.view()?.revision ?? 0; this.rotating.set(id); this.rotationToken = ''; }
  rotate(): void {
    const id = this.rotating(); if (!id || this.busy()) return;
    const request = this.api.rotate(id, this.rotationToken, this.rotationRevision);
    this.rotationToken = '';
    this.mutate(request, 'Токен проверен и заменён. Текущие запуски сохраняют своё окружение.', () => this.rotating.set(undefined));
  }
  startProject(project?: ManagedProjectDto): void {
    this.projectId = project?.id; this.project = project ? structuredClone(project.desired) : this.emptyProject();
    this.editRevision = this.view()?.revision ?? 0; this.repositories.set([]); this.nextPage.set(null);
    this.editing.set(true); this.error.set(''); this.notice.set('');
  }
  loadRepositories(page = 1): void {
    if (!this.project.connectionId) return;
    if (page === 1) { this.project.gitlabProjectId = ''; this.repositories.set([]); }
    this.api.repositories(this.project.connectionId, page).pipe(takeUntilDestroyed(this.destroy)).subscribe({
      next: result => { this.repositories.update(previous => page === 1 ? result.repositories : [...previous, ...result.repositories]); this.nextPage.set(result.nextPage); },
      error: error => this.showError(error),
    });
  }
  selectRepository(): void {
    const repository = this.repositories().find(item => item.id === this.project.gitlabProjectId);
    if (!repository) return;
    this.project.name = repository.name; this.project.baseBranch = repository.defaultBranch;
  }
  saveProject(): void {
    if (this.busy()) return;
    this.mutate(this.api.save(this.projectId, this.project, this.editRevision), 'Настройки сохранены. У включённого проекта новая версия применяется между запусками.', () => this.editing.set(false));
  }
  setEnabled(project: ManagedProjectDto, enabled: boolean): void {
    const view = this.view(); if (!view || this.busy()) return;
    this.mutate(this.api.enable(project.id, enabled, view.revision), enabled
      ? 'Запрошены проверка и применение. Следите за статусом проекта.'
      : 'Проект поставлен на паузу. Уже начатая работа не прерывается.');
  }
  statusLabel(status: ManagedProjectDto['status']): string {
    return { draft: 'Не включён', pending: 'Ожидает применения', ready: 'Применено', error: 'Ошибка проверки', paused: 'На паузе' }[status];
  }
  private mutate(request: Observable<SettingsViewDto>, message: string, completed?: () => void): void {
    this.busy.set(true); this.error.set(''); this.notice.set('');
    request.pipe(takeUntilDestroyed(this.destroy)).subscribe({ next: view => {
      this.view.set(view); this.busy.set(false); this.notice.set(message); completed?.();
    }, error: error => { this.busy.set(false); this.showError(error); } });
  }
  private showError(error: unknown): void {
    if (error instanceof HttpErrorResponse && [401, 403].includes(error.status)) {
      this.view.set(undefined); this.editing.set(false); this.rotating.set(undefined); this.connection.token = ""; this.rotationToken = "";
    }
    this.error.set(error instanceof HttpErrorResponse ? error.error?.error ?? 'Нет связи с сервером настроек.' : 'Не удалось выполнить действие.');
  }
}
