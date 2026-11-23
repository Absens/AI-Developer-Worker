import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, ElementRef, Injector, OnInit, afterNextRender, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { Observable, Subscription } from 'rxjs';

import { ManagedProjectDto, ProjectDefinitionDto, RepositoryOptionDto, SettingsViewDto } from '../models/settings.dto';
import { SettingsApiService } from '../services/settings-api.service';
import { SessionService } from '../services/session.service';
import { canUseCapability } from '../utils/task-ui';

type ProjectForm = Omit<ProjectDefinitionDto, 'minCoveragePercent' | 'maxReviewFixAttempts'> & {
  minCoveragePercent?: number | null;
  maxReviewFixAttempts?: number | null;
};

@Component({
  selector: 'app-settings-page',
  imports: [DatePipe, FormsModule, RouterLink, ButtonModule, InputTextModule, MessageModule, TagModule],
  templateUrl: './settings-page.component.html',
  styles: [`
    .settings-page .page__header button { justify-self: start; }
    .settings-columns, .settings-fields { display: grid; gap: 1rem; min-width: 0; }
    .settings-columns { grid-template-columns: minmax(15rem, 1fr) minmax(0, 2.1fr); align-items: start; }
    .settings-columns--setup { grid-template-columns: minmax(0, 38rem); }
    .settings-fields, .settings-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .settings-fields { align-items: start; }
    .settings-panel, .settings-card, .settings-form { display: grid; gap: 1rem; min-width: 0; }
    .settings-panel { padding: clamp(1rem, 2vw, 1.5rem); }
    .settings-panel h2 { margin: 0; font-size: 1.125rem; }
    .settings-panel p, .settings-next { margin: 0; overflow-wrap: anywhere; }
    .setup-overview { gap: .375rem; max-width: 38rem; }
    .settings-section-header, .settings-card-header {
      display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: .75rem;
    }
    .settings-project-queue { color: var(--console-link); justify-self: start; }
    .settings-section-header p { margin-block-start: .25rem; }
    .settings-card {
      padding: 1rem; border: 1px solid var(--console-border); border-radius: .75rem; overflow-wrap: anywhere;
    }
    .settings-card .p-button, .repository-field .p-button { justify-self: start; }
    .settings-panel[hidden], .settings-card [hidden] { display: none; }
    .settings-facts { display: grid; gap: .75rem; margin: 0; }
    .settings-facts dt, .worker-row, .settings-form small { color: var(--console-muted); }
    .settings-facts dd { margin: .15rem 0 0; font-weight: 600; }
    .settings-facts__branch { grid-column: 1 / -1; min-width: 0; }
    .settings-facts__branch dd { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .worker-row { border-block-start: 1px solid var(--console-border); padding-block-start: .75rem; }
    .settings-form fieldset { border: 0; min-width: 0; padding: 0; margin: 0; }
    .settings-form legend { padding: 0; font-weight: 650; }
    .settings-form fieldset p { margin: .375rem 0 .75rem; }
    .settings-form .field { min-width: 0; }
    .settings-form select {
      width: 100%; min-block-size: 2.75rem; padding: .5rem .625rem;
      border: 1px solid var(--p-inputtext-border-color); border-radius: var(--p-border-radius-md);
      background: var(--console-panel); color: var(--console-text);
    }
    .settings-form select:disabled { opacity: .65; }
    .settings-disclosure summary { padding: .375rem 0; cursor: pointer; font-weight: 650; }
    .settings-disclosure[open] > summary { margin-block-end: .75rem; }
    .settings-disclosure__body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }
    .settings-disclosure__body > legend { margin-block-end: .5rem; }
    .project-editor .settings-disclosure { border-block-start: 1px solid var(--console-border); padding-block-start: .5rem; }
    .project-editor { border-color: var(--console-focus); }
    .settings-next a { color: var(--console-link); }
    @media (max-width: 1120px) {
      .settings-columns { grid-template-columns: minmax(0, 1fr); }
    }
    @media (max-width: 580px) {
      .settings-page .page__header, .settings-fields { grid-template-columns: minmax(0, 1fr); }
      .settings-form .action-bar { display: grid; grid-template-columns: minmax(0, 1fr); }
      .settings-form .action-bar .p-button { width: 100%; }
    }
  `],
})
export class SettingsPageComponent implements OnInit {
  private readonly session = inject(SessionService);
  protected readonly canCreateTask = computed(() => canUseCapability(this.session.session(), 'canCreateTask'));
  private readonly api = inject(SettingsApiService);
  private readonly destroy = inject(DestroyRef);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly injector = inject(Injector);

  readonly view = signal<SettingsViewDto | undefined>(undefined);
  readonly error = signal('');
  readonly notice = signal('');
  readonly busy = signal(false);
  readonly refreshing = signal(false);
  readonly repositories = signal<RepositoryOptionDto[]>([]);
  readonly repositoriesLoading = signal(false);
  readonly repositoryError = signal(false);
  readonly nextPage = signal<number | null>(null);
  readonly editing = signal(false);
  readonly rotating = signal<string | undefined>(undefined);

  connection = { name: '', origin: '', token: '' };
  rotationToken = '';
  project: ProjectForm = this.emptyProject();
  projectId: string | undefined;

  private editRevision = 0;
  private rotationRevision = 0;
  private repositoryRequest?: Subscription;
  private projectTrigger?: HTMLButtonElement;

  ngOnInit(): void {
    this.refresh();
    const timer = setInterval(() => {
      if (!this.editing() && !this.rotating() && !this.busy()) this.refresh(false);
    }, 5000);
    this.destroy.onDestroy(() => {
      clearInterval(timer);
      this.connection.token = '';
      this.rotationToken = '';
    });
  }

  refresh(clear = true): void {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    if (clear) this.error.set('');
    this.api.read().pipe(takeUntilDestroyed(this.destroy)).subscribe({
      next: (view) => {
        this.refreshing.set(false);
        if (view.revision >= (this.view()?.revision ?? 0)) this.applyView(view);
      },
      error: (error: unknown) => {
        this.refreshing.set(false);
        this.showError(error);
      },
    });
  }

  connect(): void {
    const view = this.view();
    if (!view || this.busy()) return;
    const firstConnection = !view.connections.length;
    const request = this.api.connect(this.connection, view.revision);
    this.connection = { ...this.connection, token: '' };
    this.mutate(request, 'Подключение проверено и сохранено.', () => {
      this.connection = { ...this.connection, name: '' };
      if (firstConnection) this.focusAfterRender('#settings-add-project');
    });
  }

  beginRotation(id: string): void {
    this.rotationRevision = this.view()?.revision ?? 0;
    this.rotating.set(id);
    this.rotationToken = '';
    this.focusAfterRender('#settings-rotation-token');
  }

  cancelRotation(trigger?: HTMLButtonElement): void {
    this.rotating.set(undefined);
    this.rotationToken = '';
    if (trigger) this.focusAfterRender(trigger);
  }

  rotate(): void {
    const id = this.rotating();
    if (!id || this.busy()) return;
    const request = this.api.rotate(id, this.rotationToken, this.rotationRevision);
    this.rotationToken = '';
    this.mutate(request, 'Токен проверен и заменён. Текущие запуски сохраняют своё окружение.', () => this.cancelRotation());
  }

  startProject(project?: ManagedProjectDto, trigger?: HTMLButtonElement): void {
    this.projectId = project?.id;
    this.project = project ? structuredClone(project.desired) : this.emptyProject();
    this.projectTrigger = trigger;
    this.editRevision = this.view()?.revision ?? 0;
    this.resetRepositories();
    this.editing.set(true);
    this.error.set('');
    this.notice.set('');
    this.focusAfterRender('#settings-editor-heading');
  }

  closeProject(): void {
    this.editing.set(false);
    this.resetRepositories();
    if (this.projectTrigger) this.focusAfterRender(this.projectTrigger);
    this.projectTrigger = undefined;
  }

  loadRepositories(page = 1): void {
    if (page === 1) {
      this.resetRepositories();
      this.project.gitlabProjectId = '';
    }
    const connectionId = this.project.connectionId;
    if (!connectionId) return;
    this.repositoryError.set(false);
    this.repositoriesLoading.set(true);
    this.repositoryRequest = this.api.repositories(connectionId, page)
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (result) => {
          this.repositories.update((previous) => [...previous, ...result.repositories]);
          this.nextPage.set(result.nextPage);
          this.repositoriesLoading.set(false);
        },
        error: (error: unknown) => {
          this.repositoriesLoading.set(false);
          if (this.accessDenied(error)) this.showError(error, true);
          else this.repositoryError.set(true);
        },
      });
  }

  selectRepository(): void {
    const repository = this.repositories().find((item) => item.id === this.project.gitlabProjectId);
    if (!repository) return;
    this.project.name = repository.name;
    this.project.baseBranch = repository.defaultBranch;
  }

  saveProject(): void {
    if (this.busy()) return;
    this.mutate(
      this.api.save(this.projectId, this.projectDefinition(), this.editRevision),
      'Настройки сохранены. У включённого проекта новая версия применяется между запусками.',
      () => this.closeProject(),
    );
  }

  setEnabled(project: ManagedProjectDto, enabled: boolean): void {
    const view = this.view();
    if (!view || this.busy()) return;
    this.mutate(this.api.enable(project.id, enabled, view.revision), enabled
      ? 'Запрошены проверка и применение. Следите за статусом проекта.'
      : 'Проект поставлен на паузу. Уже начатая работа продолжится.');
  }

  statusLabel(status: ManagedProjectDto['status']): string {
    return { draft: 'Не включён', pending: 'Ожидает применения', ready: 'Применено', error: 'Ошибка проверки', paused: 'На паузе' }[status];
  }

  statusSeverity(status: ManagedProjectDto['status']): 'secondary' | 'info' | 'success' | 'danger' {
    return ({ draft: 'secondary', pending: 'info', ready: 'success', error: 'danger', paused: 'secondary' } as const)[status];
  }

  workerLabel(state: string): string {
    const labels: Record<string, string> = { ready: 'Готов', running: 'Выполняет', error: 'Ошибка', paused: 'На паузе' };
    return labels[state] ?? state;
  }

  private emptyProject(): ProjectDefinitionDto {
    return {
      name: '', connectionId: '', gitlabProjectId: '', baseBranch: 'main',
      testCommand: 'npm test', lintCommand: 'npm run lint', timeoutSeconds: 1800, maxFixAttempts: 2,
    };
  }

  private projectDefinition(): ProjectDefinitionDto {
    const { minCoveragePercent, maxReviewFixAttempts, ...fields } = this.project;
    const definition: ProjectDefinitionDto = { ...fields };
    const optionalText = [
      'buildCommand', 'typeCheckCommand', 'securityScanCommand', 'sastCommand',
      'coverageCommand', 'coverageReportFile', 'visualRegressionCommand', 'model',
    ] as const;
    for (const key of optionalText) {
      const value = definition[key]?.trim();
      if (value) definition[key] = value;
      else delete definition[key];
    }
    if (definition.coverageCommand) {
      if (minCoveragePercent != null) definition.minCoveragePercent = minCoveragePercent;
    } else {
      delete definition.coverageReportFile;
    }
    if (maxReviewFixAttempts != null) definition.maxReviewFixAttempts = maxReviewFixAttempts;
    return definition;
  }

  private applyView(view: SettingsViewDto): void {
    this.view.set(view);
    if (!view.allowedOrigins.includes(this.connection.origin)) {
      this.connection.origin = view.allowedOrigins[0] ?? '';
    }
  }

  private resetRepositories(): void {
    this.repositoryRequest?.unsubscribe();
    this.repositories.set([]);
    this.nextPage.set(null);
    this.repositoriesLoading.set(false);
    this.repositoryError.set(false);
  }

  private mutate(request: Observable<SettingsViewDto>, message: string, completed?: () => void): void {
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    request.pipe(takeUntilDestroyed(this.destroy)).subscribe({
      next: (view) => {
        if (view.revision >= (this.view()?.revision ?? 0)) this.applyView(view);
        this.busy.set(false);
        this.notice.set(message);
        completed?.();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.showError(error, true);
      },
    });
  }

  private accessDenied(error: unknown): boolean {
    return error instanceof HttpErrorResponse && [401, 403].includes(error.status);
  }

  private showError(error: unknown, focus = false): void {
    if (this.accessDenied(error)) {
      this.view.set(undefined);
      this.editing.set(false);
      this.resetRepositories();
      this.cancelRotation();
      this.connection.token = '';
    }
    this.error.set(error instanceof HttpErrorResponse
      ? error.error?.error ?? 'Нет связи с сервером настроек.'
      : 'Не удалось выполнить действие.');
    if (focus) this.focusAfterRender('[data-testid="settings-error"]');
  }

  private focusAfterRender(target: string | HTMLElement): void {
    afterNextRender(() => {
      const element = typeof target === 'string'
        ? this.host.nativeElement.querySelector<HTMLElement>(target)
        : target;
      element?.focus();
    }, { injector: this.injector });
  }
}
