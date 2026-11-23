import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import { map } from 'rxjs';

import { CreateTaskRequestDto } from '../models/human-api.dto';
import { ProjectCatalogEntry } from '../models/settings.dto';
import { SessionService } from '../services/session.service';
import { SettingsApiService } from '../services/settings-api.service';
import { TaskApiService } from '../services/task-api.service';
import { canUseCapability, splitListInput } from '../utils/task-ui';

type TaskType = NonNullable<CreateTaskRequestDto['taskType']>;

interface TemplateOption {
  label: string;
  value: TaskType;
  description: string;
  acceptanceCriteria: string[];
  constraints: string[];
  riskFactors: string[];
}

interface PreviewRow {
  label: string;
  value: string;
}

interface RepositoryChoice extends ProjectCatalogEntry {
  address: string;
  optionLabel: string;
}

const tagPattern = /^[A-Za-z0-9_.:-]+$/;
const requiredText = (control: AbstractControl<string>): ValidationErrors | null =>
  control.value.trim() ? null : { required: true };

const tagListValidator = (control: AbstractControl<string>): ValidationErrors | null => {
  const invalid = splitListInput(control.value).some((entry) => !tagPattern.test(entry));
  return invalid ? { tagList: true } : null;
};

const listTextValidator = (control: AbstractControl<string>): ValidationErrors | null => {
  const malformed = splitListInput(control.value).some((entry) => entry.length < 3);
  return malformed ? { listText: true } : null;
};

@Component({
  selector: 'app-create-task-page',
  imports: [
    ButtonModule,
    RouterLink,
    DialogModule,
    InputTextModule,
    MessageModule,
    ReactiveFormsModule,
    SelectModule,
    TextareaModule,
  ],
  template: `
    <section class="page create-page" data-testid="create-page">
      <header class="page__header">
        <div>
          <h1>Новая задача</h1>
          <p>Сохраните черновик или отправьте задачу в очередь исполнения.</p>
        </div>
        <a class="back-link" routerLink="/"><i class="pi pi-arrow-left" aria-hidden="true"></i> К задачам</a>
      </header>

      @if (!canCreateTask()) {
        <p-message data-testid="create-unauthorized" severity="warn" text="Текущая сессия не может создавать задачи." />
      }

      <form class="surface create-form" data-testid="create-form" [formGroup]="form" (ngSubmit)="createDraft()">
        @if (managedMode()) {
          @if (canCreateTask()) {
            <div class="field">
              <label class="field-label" id="create-project-label" for="create-project">Репозиторий *</label>
              @switch (catalogStatus()) {
                @case ('loading') {
                  <p class="muted field-note" role="status">Загружаем репозитории…</p>
                }
                @case ('error') {
                  <div class="catalog-state">
                    <p-message severity="error" text="Не удалось загрузить репозитории." />
                    <button pButton type="button" label="Повторить" severity="secondary" data-testid="create-retry-catalog" (click)="retryCatalog()"></button>
                  </div>
                }
                @case ('ready') {
                  @if (managedProjects().length) {
                    <p-select
                      data-testid="managed-project-select"
                      inputId="create-project"
                      ariaLabelledBy="create-project-label"
                      formControlName="repositoryName"
                      [options]="managedProjects()"
                      optionLabel="optionLabel"
                      optionValue="id"
                      placeholder="Выберите репозиторий"
                      required
                      [filter]="true"
                      filterBy="name,repositoryPath,gitlabHost,address"
                      filterPlaceholder="Поиск по имени или адресу"
                      ariaFilterLabel="Поиск репозитория"
                      emptyFilterMessage="Репозитории не найдены"
                      [resetFilterOnHide]="true"
                    >
                      <ng-template #selectedItem let-project>
                        <span class="repository-selected">{{ project.name }}</span>
                      </ng-template>
                      <ng-template #item let-project>
                        <div class="repository-option" [title]="project.optionLabel">
                          <strong>{{ project.name }}</strong>
                          @if (project.address) { <small>{{ project.address }}</small> }
                          <small>Ветка {{ project.baseBranch }}</small>
                        </div>
                      </ng-template>
                    </p-select>
                    @if (selectedProject(); as project) {
                      @if (project.address) {
                        <small class="muted repository-line" [title]="project.address">{{ project.address }}</small>
                      }
                      <small class="muted repository-line" [title]="project.baseBranch">Базовая ветка {{ project.baseBranch }}</small>
                    } @else if (unavailableRequestedProject()) {
                      <small class="error-text" role="alert">Репозиторий из ссылки недоступен. Выберите другой.</small>
                    } @else if (projectRequired()) {
                      <small class="error-text" role="alert">Выберите репозиторий.</small>
                    }
                  } @else {
                    <div class="catalog-state">
                      @if (unavailableRequestedProject()) {
                        <small class="error-text" role="alert">Репозиторий из ссылки недоступен.</small>
                      }
                      <p class="muted field-note" role="status">Для создания задачи нужен включённый проект с применёнными настройками.</p>
                      @if (canManageSettings()) {
                        <a routerLink="/settings" class="back-link">Открыть настройки проектов</a>
                      } @else {
                        <p class="muted field-note">Попросите администратора включить проект.</p>
                      }
                    </div>
                  }
                }
              }
            </div>
          }
        } @else {
          <label class="field"><span>Репозиторий</span><input pInputText data-testid="create-repository" formControlName="repositoryName" placeholder="developer" /></label>
        }

        <div class="form-section">
          <div class="field">
            <label class="field-label" for="create-title">Название *</label>
            <input
              pInputText
              id="create-title"
              data-testid="create-title"
              formControlName="title"
              placeholder="Например, добавить фильтр по статусу"
              aria-required="true"
              [attr.aria-invalid]="hasError('title')"
              [attr.aria-describedby]="hasError('title') ? 'create-title-error' : null"
            />
            @if (hasError('title')) {
              <small id="create-title-error" class="error-text">Укажите название.</small>
            }
          </div>

          <div class="field">
            <label class="field-label" for="create-description">Описание *</label>
            <textarea
              pTextarea
              id="create-description"
              data-testid="create-description"
              rows="4"
              formControlName="description"
              placeholder="Что нужно изменить и каким должен быть результат?"
              aria-required="true"
              [attr.aria-invalid]="hasError('description')"
              [attr.aria-describedby]="hasError('description') ? 'create-description-error' : null"
            ></textarea>
            @if (hasError('description')) {
              <small id="create-description-error" class="error-text">Укажите описание.</small>
            }
          </div>
        </div>

        <div class="form-section">
          <div class="field">
            <label id="create-template-label" class="field-label" for="create-template">Шаблон задачи</label>
            <p-select
              inputId="create-template"
              ariaLabelledBy="create-template-label"
              data-testid="create-task-type"
              formControlName="taskType"
              [options]="templates"
              optionLabel="label"
              optionValue="value"
              placeholder="Выберите шаблон"
              (onChange)="applyTemplate()"
            />
            @if (selectedTemplate(); as template) {
              <small>{{ template.description }}</small>
            }
          </div>
          <div class="field">
            <label class="field-label" for="create-acceptance">Критерии приёмки</label>
            <textarea
              pTextarea
              id="create-acceptance"
              data-testid="create-acceptance"
              rows="3"
              formControlName="acceptanceCriteria"
              aria-describedby="create-acceptance-hint"
              [attr.aria-invalid]="hasError('acceptanceCriteria')"
            ></textarea>
            <small id="create-acceptance-hint" [class.error-text]="hasError('acceptanceCriteria')">
              @if (hasError('acceptanceCriteria')) {
                Каждый критерий должен содержать не меньше трёх символов.
              } @else {
                По одному критерию на строку. Шаблон подставляет примеры, их можно изменить.
              }
            </small>
          </div>
        </div>

        <details class="advanced-fields" data-testid="create-advanced">
          <summary>Дополнительные параметры</summary>
          <div class="advanced-fields__body">
            @if (!managedMode()) {
              <fieldset>
                <legend>Репозиторий и очередь</legend>
                <div class="field-grid create-fields">
                  <label class="field"><span>Ключ пути репозитория</span><input pInputText data-testid="create-repo-path-key" formControlName="repoPathKey" placeholder="developer" /></label>
                  <label class="field"><span>Базовая ветка</span><input pInputText data-testid="create-base-branch" formControlName="baseBranch" placeholder="main" /></label>
                  <label class="field"><span>Очередь</span><input pInputText data-testid="create-queue" formControlName="queue" placeholder="DEV" /></label>
                </div>
              </fieldset>
            }
            <div class="field-grid create-fields">
              <label class="field"><span>Приоритет</span><input pInputText data-testid="create-priority" formControlName="priority" placeholder="normal" /></label>
              <label class="field"><span>Профиль промпта</span><input pInputText data-testid="create-prompt-profile" formControlName="promptProfileId" placeholder="frontend_ui_fix" /></label>
              <label class="field"><span>Краткое описание для оператора</span><input pInputText data-testid="create-human-summary" formControlName="humanSummary" /></label>
              <div class="field">
                <label class="field-label" for="create-tags">Теги</label>
                <input pInputText id="create-tags" data-testid="create-tags" formControlName="tags" placeholder="ai_dev,frontend" [attr.aria-invalid]="hasError('tags')" [attr.aria-describedby]="hasError('tags') ? 'create-tags-error' : null" />
                @if (hasError('tags')) {
                  <small id="create-tags-error" class="error-text">Используйте латинские буквы, цифры, точку, подчёркивание, двоеточие и дефис.</small>
                }
              </div>
              <div class="field">
                <label class="field-label" for="create-components">Компоненты</label>
                <input pInputText id="create-components" data-testid="create-components" formControlName="components" placeholder="web,api" [attr.aria-invalid]="hasError('components')" [attr.aria-describedby]="hasError('components') ? 'create-components-error' : null" />
                @if (hasError('components')) {
                  <small id="create-components-error" class="error-text">Используйте латинские буквы, цифры, точку, подчёркивание, двоеточие и дефис.</small>
                }
              </div>
              @for (item of contextFields; track item.name) {
                <div class="field">
                  <label class="field-label" [for]="item.id">{{ item.label }}</label>
                  <textarea pTextarea [id]="item.id" [attr.data-testid]="item.id" rows="3" [formControlName]="item.name" placeholder="По одному пункту на строку" [attr.aria-invalid]="hasError(item.name)" [attr.aria-describedby]="hasError(item.name) ? item.id + '-error' : null"></textarea>
                  @if (hasError(item.name)) {
                    <small [id]="item.id + '-error'" class="error-text">Каждый пункт должен содержать не меньше трёх символов.</small>
                  }
                </div>
              }
            </div>
          </div>
        </details>

        @if (error(); as message) {
          <div class="create-submit-error" tabindex="-1" data-testid="create-error">
            <p-message severity="error" [text]="message" />
          </div>
        }
        <div class="action-bar create-actions">
          <button
            pButton
            type="button"
            data-testid="create-preview"
            icon="pi pi-eye"
            label="Предпросмотр"
            severity="secondary"
            [disabled]="form.controls.title.invalid || form.controls.description.invalid || (managedMode() && !selectedProject())"
            (click)="openPreview()"
          ></button>
          <button
            pButton
            type="submit"
            data-testid="create-draft"
            icon="pi pi-save"
            label="Сохранить черновик"
            severity="secondary"
            [disabled]="!canSubmit()"
          ></button>
          <button
            pButton
            type="button"
            data-testid="create-ready"
            icon="pi pi-arrow-right"
            label="Поставить в очередь"
            [disabled]="!canSubmit()"
            (click)="createReady()"
          ></button>
        </div>
      </form>
    </section>

    <p-dialog
      header="Предпросмотр задачи"
      [visible]="previewVisible()"
      (visibleChange)="previewVisible.set($event)"
      [modal]="true"
      [style]="{ width: 'min(760px, 94vw)' }"
      contentStyleClass="dialog-scroll"
    >
      <div data-testid="create-preview-dialog">
      <p class="muted">Предпросмотр сформирован из текущих значений формы. Контекст агента будет доступен в карточке задачи.</p>
      <div class="preview-grid">
        @for (row of previewRows(); track row.label) {
          <div class="preview-row preview-row--wide">
            <span>{{ row.label }}</span>
            <pre>{{ row.value }}</pre>
          </div>
        }
      </div>
      </div>
    </p-dialog>
  `,
  styles: [`
    .create-page { width: 100%; max-width: 58rem; }
    .back-link { color: var(--console-link); overflow-wrap: anywhere; }
    .back-link i { margin-inline-end: .25rem; }
    .create-form { display: grid; gap: 1.25rem; padding: clamp(1rem, 2.4vw, 1.75rem); min-width: 0; }
    .form-section, .advanced-fields__body { display: grid; gap: 1rem; }
    .field-note { margin: 0; }
    .repository-option { display: grid; min-width: 0; max-width: 100%; gap: .125rem; }
    .repository-option > *, .repository-line, .repository-selected {
      display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .repository-option small { color: var(--console-muted); }
    .catalog-state { display: grid; gap: .5rem; justify-items: start; }
    .create-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .create-fields > .field { min-width: 0; }
    .create-form textarea { resize: vertical; }
    .create-form fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
    .create-form legend { font-weight: 650; padding: 0; margin-block-end: .5rem; }
    .advanced-fields { border-block: 1px solid var(--console-border); }
    .advanced-fields summary { padding: .75rem 0; cursor: pointer; font-weight: 650; }
    .advanced-fields__body { padding-block-end: 1rem; }
    .create-actions { justify-content: flex-end; }
    .create-actions [data-testid="create-preview"] { margin-inline-end: auto; }
    @media (max-width: 640px) {
      .create-page .page__header, .create-fields { grid-template-columns: minmax(0, 1fr); }
      .create-actions { display: grid; grid-template-columns: minmax(0, 1fr); }
      .create-actions [data-testid="create-preview"] { margin: 0; }
    }
  `],
})
export class CreateTaskPageComponent {
  private readonly settingsApi = inject(SettingsApiService);
  private readonly destroy = inject(DestroyRef);
  private readonly taskApi = inject(TaskApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly messages = inject(MessageService);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly injector = inject(Injector);
  private readonly catalogAttempt = signal(0);
  private readonly requestedProjectId = toSignal(this.route.queryParamMap.pipe(map((params) => params.get('project'))), {
    initialValue: null,
  });
  private pendingSystemSubmission?: { payload: string; idempotencyKey: string };

  protected readonly managedProjects = signal<RepositoryChoice[]>([]);
  protected readonly catalogStatus = signal<'loading' | 'error' | 'ready'>('loading');
  protected readonly projectRequired = signal(false);
  protected readonly managedMode = computed(() => Boolean(this.session.session()?.capabilities?.['managedProjects']));
  protected readonly canCreateTask = computed(() => canUseCapability(this.session.session(), 'canCreateTask'));
  protected readonly canManageSettings = computed(() => canUseCapability(this.session.session(), 'canManageSettings'));
  protected readonly contextFields = [
    { name: 'constraints', id: 'create-constraints', label: 'Ограничения' },
    { name: 'riskFactors', id: 'create-risk-factors', label: 'Риски' },
    { name: 'missingContext', id: 'create-missing-context', label: 'Недостающий контекст' },
  ] as const;

  protected readonly templates: TemplateOption[] = [
    {
      label: 'Backend endpoint',
      value: 'backend_endpoint',
      description: 'Работа с API, обработчиком, валидацией, авторизацией или хранением данных.',
      acceptanceCriteria: ['Пути успеха и ошибки endpoint покрыты.', 'Поведение авторизации проверено.'],
      constraints: ['Сохранять существующие публичные контракты, если явно не указано обратное.'],
      riskFactors: ['Обратно несовместимое поведение API.', 'Недостающая валидация или авторизация.'],
    },
    {
      label: 'Frontend UI',
      value: 'frontend_ui_fix',
      description: 'Работа с компонентом, layout, доступностью или UI-сценарием.',
      acceptanceCriteria: ['Затронутое состояние UI отображается корректно.', 'Адаптивность и интерактивные состояния проверены.'],
      constraints: ['Следовать существующей дизайн-системе и паттернам компонентов.'],
      riskFactors: ['Визуальная регрессия в соседних состояниях.', 'Регрессии клавиатуры или фокуса.'],
    },
    {
      label: 'Только тесты',
      value: 'tests_only',
      description: 'Точечные тесты без production-изменений, кроме случаев, когда обнаружен реальный дефект.',
      acceptanceCriteria: ['Ожидаемое поведение покрыто тестами.', 'Точечные и широкие проверки проходят.'],
      constraints: ['Не менять production-код, если это не нужно для исправления реального падающего поведения.'],
      riskFactors: ['Хрупкие проверки, привязанные к деталям реализации.'],
    },
    {
      label: 'Рефакторинг',
      value: 'refactor',
      description: 'Очистка или извлечение без изменения поведения.',
      acceptanceCriteria: ['Поведение сохранено.', 'Релевантные проверки проходят после рефакторинга.'],
      constraints: ['Ограничить изменения запрошенной подсистемой.'],
      riskFactors: ['Смещение поведения, скрытое структурными изменениями.'],
    },
    {
      label: 'Обновление зависимостей',
      value: 'dependency_update',
      description: 'Изменения manifest и lockfile зависимостей.',
      acceptanceCriteria: ['Manifest и lockfile согласованы.', 'Сборка и тесты проходят с обновленными зависимостями.'],
      constraints: ['Не включать несвязанный churn зависимостей.'],
      riskFactors: ['Поломки транзитивных зависимостей.', 'Изменения runtime-совместимости.'],
    },
    {
      label: 'Документация',
      value: 'documentation',
      description: 'Readme, runbook или пользовательская документация.',
      acceptanceCriteria: ['Команды и имена конфигурации соответствуют репозиторию.', 'Документация краткая и применимая.'],
      constraints: ['Не менять runtime-код, если это не нужно для проверки документации.'],
      riskFactors: ['Устаревшие примеры команд.', 'Расхождение документации с поведением кода.'],
    },
  ];

  protected readonly form = new FormGroup({
    taskType: new FormControl<TaskType>('backend_endpoint', { nonNullable: true }),
    promptProfileId: new FormControl('backend_endpoint', { nonNullable: true }),
    title: new FormControl('', { nonNullable: true, validators: [requiredText] }),
    description: new FormControl('', { nonNullable: true, validators: [requiredText] }),
    humanSummary: new FormControl('', { nonNullable: true }),
    repositoryName: new FormControl('developer', { nonNullable: true }),
    repoPathKey: new FormControl('developer', { nonNullable: true }),
    baseBranch: new FormControl('main', { nonNullable: true }),
    queue: new FormControl('DEV', { nonNullable: true }),
    priority: new FormControl('normal', { nonNullable: true }),
    tags: new FormControl('ai_dev', { nonNullable: true, validators: [tagListValidator] }),
    components: new FormControl('', { nonNullable: true, validators: [tagListValidator] }),
    acceptanceCriteria: new FormControl('', { nonNullable: true, validators: [listTextValidator] }),
    constraints: new FormControl('', { nonNullable: true, validators: [listTextValidator] }),
    riskFactors: new FormControl('', { nonNullable: true, validators: [listTextValidator] }),
    missingContext: new FormControl('', { nonNullable: true, validators: [listTextValidator] }),
  });

  private readonly repositoryName = toSignal(this.form.controls.repositoryName.valueChanges, {
    initialValue: this.form.controls.repositoryName.value,
  });
  protected readonly selectedProject = computed(() =>
    this.managedProjects().find((project) => project.id === this.repositoryName()),
  );
  protected readonly unavailableRequestedProject = computed(() => {
    const requested = this.requestedProjectId();
    return requested !== null && !this.managedProjects().some((project) => project.id === requested);
  });
  protected readonly submitting = signal(false);
  protected readonly canSubmit = computed(() =>
    this.canCreateTask() && !this.submitting() &&
    (!this.managedMode() || (this.catalogStatus() === 'ready' && this.managedProjects().length > 0)),
  );
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly previewVisible = signal(false);
  protected readonly previewRows = signal<PreviewRow[]>([]);
  protected readonly selectedTemplate = signal<TemplateOption | undefined>(undefined);

  constructor() {
    this.applyTemplate();
    effect((onCleanup) => {
      if (!this.managedMode() || !this.canCreateTask()) return;
      this.catalogAttempt();
      this.catalogStatus.set('loading');
      const request = this.settingsApi.catalog().subscribe({
        next: ({ projects }) => {
          this.managedProjects.set(projects.map((project) => {
            const address = [project.gitlabHost, project.repositoryPath].filter(Boolean).join('/');
            const optionLabel = [project.name, address, project.baseBranch].filter(Boolean).join(' · ');
            return { ...project, address, optionLabel };
          }));
          this.catalogStatus.set('ready');
        },
        error: () => this.catalogStatus.set('error'),
      });
      onCleanup(() => request.unsubscribe());
    });
    effect(() => {
      if (!this.managedMode() || this.catalogStatus() !== 'ready') return;
      const control = this.form.controls.repositoryName;
      const requested = this.requestedProjectId();
      const candidate = requested ?? control.value;
      const choice = this.managedProjects().find((project) => project.id === candidate);
      control.setValue(choice?.id ?? '');
      this.projectRequired.set(false);
    });
  }

  protected retryCatalog(): void {
    this.catalogAttempt.update((attempt) => attempt + 1);
  }

  protected applyTemplate(): void {
    const template = this.templates.find((entry) => entry.value === this.form.controls.taskType.value);
    if (!template) return;
    const previous = this.selectedTemplate();
    this.selectedTemplate.set(template);
    const profile = this.form.controls.promptProfileId;
    if (!previous || !profile.value.trim() || profile.value === previous.value) {
      profile.setValue(template.value);
    }
    for (const field of ['acceptanceCriteria', 'constraints', 'riskFactors'] as const) {
      const control = this.form.controls[field];
      if (!control.value.trim() || control.value === previous?.[field].join('\n')) {
        control.setValue(template[field].join('\n'));
      }
    }
  }

  protected hasError(controlName: keyof CreateTaskPageComponent['form']['controls']): boolean {
    const control = this.form.controls[controlName];
    return control.invalid && (control.dirty || control.touched);
  }

  protected createDraft(): void {
    this.submit('new');
  }

  protected createReady(): void {
    this.submit('ready');
  }

  protected openPreview(): void {
    const project = this.selectedProject();
    if (this.managedMode() && !project) return;
    if (this.form.controls.title.invalid || this.form.controls.description.invalid) {
      this.form.controls.title.markAsTouched();
      this.form.controls.description.markAsTouched();
      return;
    }
    const payload = this.buildPayload();
    const repositoryLabel = project
      ? [project.name, project.address].filter(Boolean).join(' · ')
      : payload.repositoryName || 'Не назначен';
    const tags = [...new Set([...(project?.tags ?? []), ...(payload.tags ?? [])])];
    this.previewRows.set([
      { label: 'Название', value: payload.title },
      { label: 'Описание', value: payload.description },
      { label: 'Репозиторий', value: repositoryLabel },
      { label: 'Базовая ветка', value: project?.baseBranch || payload.baseBranch || 'По умолчанию' },
      { label: 'Очередь', value: project?.queue || payload.queue || 'Не назначена' },
      { label: 'Тип задачи', value: payload.taskType || 'Не указан' },
      { label: 'Теги', value: tags.join('\n') || 'Нет' },
      { label: 'Критерии приемки', value: payload.acceptanceCriteria?.join('\n') || 'Нет' },
      { label: 'Ограничения', value: payload.constraints?.join('\n') || 'Нет' },
      { label: 'Риски', value: payload.riskFactors?.join('\n') || 'Нет' },
      { label: 'Недостающий контекст', value: payload.missingContext?.join('\n') || 'Нет' },
    ]);
    this.previewVisible.set(true);
  }

  private submit(status: CreateTaskRequestDto['status'] | undefined): void {
    if (!this.canSubmit()) return;
    const missingProject = this.managedMode() && !this.selectedProject();
    this.projectRequired.set(missingProject);
    this.error.set(undefined);
    if (this.form.invalid || missingProject) {
      this.form.markAllAsTouched();
      const field = this.host.nativeElement.querySelector<HTMLElement>(
        'input.ng-invalid, textarea.ng-invalid' + (missingProject ? ', #create-project' : ''),
      );
      const details = field?.closest('details');
      if (details) details.open = true;
      field?.focus();
      return;
    }
    const payload: CreateTaskRequestDto = { ...this.buildPayload(), ...(status ? { status } : {}) };
    const request = this.withSystemIdempotency(payload);
    this.submitting.set(true);
    this.taskApi.createTask(request)
      .pipe(takeUntilDestroyed(this.destroy)).subscribe({
      next: (response) => {
        this.messages.add({
          severity: 'success',
          summary: status === 'ready' ? 'Задача поставлена в очередь' : 'Черновик задачи создан',
        });
        this.router.navigate(['/', response.task.id]);
      },
      error: (error: unknown) => {
        this.error.set(error instanceof Error ? error.message : String(error));
        this.submitting.set(false);
        afterNextRender(() => {
          this.host.nativeElement.querySelector<HTMLElement>('.create-submit-error')?.focus();
        }, { injector: this.injector });
      },
    });
  }

  private withSystemIdempotency(payload: CreateTaskRequestDto): CreateTaskRequestDto {
    if (this.session.session()?.user.service !== 'system') {
      return payload;
    }
    const serialized = JSON.stringify(payload);
    if (this.pendingSystemSubmission?.payload !== serialized) {
      this.pendingSystemSubmission = {
        payload: serialized,
        idempotencyKey: 'console-' + globalThis.crypto.getRandomValues(new Uint32Array(4)).join('-'),
      };
    }
    return { ...payload, idempotencyKey: this.pendingSystemSubmission.idempotencyKey };
  }

  private buildPayload(): CreateTaskRequestDto {
    const value = this.form.getRawValue();
    const optional = (entry: string): string | undefined => {
      const trimmed = entry.trim();
      return trimmed || undefined;
    };
    const project = this.selectedProject();
    const routing = this.managedMode()
      ? { repositoryName: project?.id }
      : {
          ...(optional(value.repositoryName) ? { repositoryName: optional(value.repositoryName) } : {}),
          ...(optional(value.repoPathKey) ? { repoPathKey: optional(value.repoPathKey) } : {}),
          ...(optional(value.baseBranch) ? { baseBranch: optional(value.baseBranch) } : {}),
          ...(optional(value.queue) ? { queue: optional(value.queue) } : {}),
        };
    return {
      title: value.title.trim(),
      description: value.description.trim(),
      ...(optional(value.humanSummary) ? { humanSummary: optional(value.humanSummary) } : {}),
      ...routing,
      ...(optional(value.priority) ? { priority: optional(value.priority) } : {}),
      tags: splitListInput(value.tags),
      components: splitListInput(value.components),
      acceptanceCriteria: splitListInput(value.acceptanceCriteria),
      constraints: splitListInput(value.constraints),
      riskFactors: splitListInput(value.riskFactors),
      missingContext: splitListInput(value.missingContext),
      taskType: value.taskType,
      promptProfileId: value.promptProfileId.trim() || value.taskType,
    };
  }
}
