import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';

import { CreateTaskRequestDto } from '../models/human-api.dto';
import { SessionService } from '../services/session.service';
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

const tagPattern = /^[A-Za-z0-9_.:-]+$/;

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
    CommonModule,
    DialogModule,
    InputTextModule,
    MessageModule,
    ReactiveFormsModule,
    SelectModule,
    TagModule,
    TextareaModule,
  ],
  template: `
    <section class="page create-page" data-testid="create-page">
      <header class="page__header">
        <h1>Создать задачу</h1>
        <p>Создайте черновик для человека или сразу отправьте проверенную задачу в готовую очередь.</p>
      </header>

      @if (!canCreateTask()) {
        <p-message data-testid="create-unauthorized" severity="warn" text="Текущая сессия не может создавать задачи." />
      }

      @if (error()) {
        <p-message data-testid="create-error" severity="error" [text]="error() || 'Не удалось создать задачу'" />
      }

      <form class="surface create-form" data-testid="create-form" [formGroup]="form" (ngSubmit)="createDraft()">
        <div class="form-section">
          <h2>Шаблон</h2>
          <div class="field-grid">
            <label class="field">
              <span>Шаблон задачи</span>
              <p-select
                data-testid="create-task-type"
                formControlName="taskType"
                [options]="templates"
                optionLabel="label"
                optionValue="value"
                placeholder="Выберите шаблон"
                (onChange)="applyTemplate()"
              />
            </label>
            <label class="field">
              <span>Профиль промпта</span>
              <input pInputText data-testid="create-prompt-profile" formControlName="promptProfileId" placeholder="frontend_ui_fix" />
            </label>
          </div>
          @if (selectedTemplate(); as template) {
            <p class="muted">{{ template.description }}</p>
          }
        </div>

        <div class="form-section">
          <h2>Задача</h2>
          <label class="field">
            <span>Название *</span>
            <input pInputText data-testid="create-title" formControlName="title" placeholder="Короткое название задачи в повелительном стиле" />
            @if (hasError('title')) {
              <small class="error-text">Укажите название.</small>
            }
          </label>

          <label class="field">
            <span>Описание *</span>
            <textarea
              pTextarea
              data-testid="create-description"
              rows="8"
              formControlName="description"
              placeholder="Опишите изменение, контекст и ожидаемое поведение."
            ></textarea>
            @if (hasError('description')) {
              <small class="error-text">Укажите описание.</small>
            }
          </label>

          <label class="field">
            <span>Кратко для человека</span>
            <input pInputText data-testid="create-human-summary" formControlName="humanSummary" placeholder="Необязательное резюме для оператора" />
          </label>
        </div>

        <div class="form-section">
          <h2>Маршрутизация</h2>
          <div class="field-grid">
            <label class="field">
              <span>Репозиторий</span>
              <input pInputText data-testid="create-repository" formControlName="repositoryName" placeholder="developer" />
            </label>
            <label class="field">
              <span>Ключ пути репозитория</span>
              <input pInputText data-testid="create-repo-path-key" formControlName="repoPathKey" placeholder="developer" />
            </label>
            <label class="field">
              <span>Базовая ветка</span>
              <input pInputText data-testid="create-base-branch" formControlName="baseBranch" placeholder="main" />
            </label>
            <label class="field">
              <span>Очередь</span>
              <input pInputText data-testid="create-queue" formControlName="queue" placeholder="DEV" />
            </label>
            <label class="field">
              <span>Приоритет</span>
              <input pInputText data-testid="create-priority" formControlName="priority" placeholder="normal" />
            </label>
          </div>
        </div>

        <div class="form-section">
          <h2>Контекст</h2>
          <div class="field-grid">
            <label class="field">
              <span>Теги</span>
              <input pInputText data-testid="create-tags" formControlName="tags" placeholder="ai_dev,frontend" />
              @if (hasError('tags')) {
                <small class="error-text">В тегах можно использовать буквы, цифры, точку, подчеркивание, двоеточие и дефис.</small>
              }
            </label>
            <label class="field">
              <span>Компоненты</span>
              <input pInputText data-testid="create-components" formControlName="components" placeholder="web,api" />
              @if (hasError('components')) {
                <small class="error-text">Для компонентов используется тот же формат, что и для тегов.</small>
              }
            </label>
          </div>

          <label class="field">
            <span>Критерии приемки</span>
            <textarea
              pTextarea
              data-testid="create-acceptance"
              rows="5"
              formControlName="acceptanceCriteria"
              placeholder="Один критерий на строку"
            ></textarea>
            @if (hasError('acceptanceCriteria')) {
              <small class="error-text">Каждый критерий должен содержать минимум 3 символа.</small>
            }
          </label>

          <div class="field-grid">
            <label class="field">
              <span>Ограничения</span>
              <textarea pTextarea data-testid="create-constraints" rows="4" formControlName="constraints" placeholder="По одному на строку"></textarea>
            </label>
            <label class="field">
              <span>Риски</span>
              <textarea pTextarea data-testid="create-risk-factors" rows="4" formControlName="riskFactors" placeholder="По одному на строку"></textarea>
            </label>
            <label class="field">
              <span>Недостающий контекст</span>
              <textarea pTextarea data-testid="create-missing-context" rows="4" formControlName="missingContext" placeholder="По одному на строку"></textarea>
            </label>
          </div>
        </div>

        <div class="action-bar action-bar--end">
          <button
            pButton
            type="button"
            data-testid="create-preview"
            icon="pi pi-eye"
            label="Предпросмотр контекста"
            severity="secondary"
            [disabled]="form.controls.title.invalid || form.controls.description.invalid"
            (click)="openPreview()"
          ></button>
          <button
            pButton
            type="submit"
            data-testid="create-draft"
            icon="pi pi-save"
            label="Сохранить черновик"
            severity="secondary"
            [disabled]="submitting() || !canCreateTask()"
          ></button>
          <button
            pButton
            type="button"
            data-testid="create-ready"
            icon="pi pi-check-circle"
            label="Создать готовую"
            [disabled]="submitting() || !canCreateTask()"
            (click)="createReady()"
          ></button>
        </div>
      </form>
    </section>

    <p-dialog
      header="Предпросмотр введенного контекста"
      [visible]="previewVisible()"
      (visibleChange)="previewVisible.set($event)"
      [modal]="true"
      [style]="{ width: 'min(760px, 94vw)' }"
      contentStyleClass="dialog-scroll"
    >
      <div data-testid="create-preview-dialog">
      <p class="muted">
        Этот предпросмотр сформирован из текущих значений формы. Предпросмотр контекста backend-агента будет доступен после создания задачи.
      </p>
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
})
export class CreateTaskPageComponent {
  private readonly taskApi = inject(TaskApiService);
  private readonly router = inject(Router);
  private readonly session = inject(SessionService);
  private readonly messages = inject(MessageService);

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
    title: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    description: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
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

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly previewVisible = signal(false);
  protected readonly previewRows = signal<PreviewRow[]>([]);
  protected readonly selectedTemplate = signal<TemplateOption | undefined>(undefined);

  constructor() {
    this.applyTemplate();
  }

  protected canCreateTask(): boolean {
    return canUseCapability(this.session.session(), 'canCreateTask');
  }

  protected applyTemplate(): void {
    const template = this.templates.find((entry) => entry.value === this.form.controls.taskType.value);
    if (!template) {
      return;
    }
    this.selectedTemplate.set(template);
    this.form.patchValue({
      promptProfileId: template.value,
      acceptanceCriteria: template.acceptanceCriteria.join('\n'),
      constraints: template.constraints.join('\n'),
      riskFactors: template.riskFactors.join('\n'),
    });
  }

  protected hasError(controlName: keyof CreateTaskPageComponent['form']['controls']): boolean {
    const control = this.form.controls[controlName];
    return control.invalid && (control.dirty || control.touched);
  }

  protected createDraft(): void {
    this.submit(undefined);
  }

  protected createReady(): void {
    this.submit('ready');
  }

  protected openPreview(): void {
    if (this.form.controls.title.invalid || this.form.controls.description.invalid) {
      this.form.controls.title.markAsTouched();
      this.form.controls.description.markAsTouched();
      return;
    }
    const payload = this.buildPayload();
    this.previewRows.set([
      { label: 'Название', value: payload.title },
      { label: 'Описание', value: payload.description },
      { label: 'Репозиторий', value: payload.repositoryName || 'Не назначен' },
      { label: 'Очередь', value: payload.queue || 'Не назначена' },
      { label: 'Тип задачи', value: payload.taskType || 'Не указан' },
      { label: 'Теги', value: payload.tags?.join('\n') || 'Нет' },
      { label: 'Критерии приемки', value: payload.acceptanceCriteria?.join('\n') || 'Нет' },
      { label: 'Ограничения', value: payload.constraints?.join('\n') || 'Нет' },
      { label: 'Риски', value: payload.riskFactors?.join('\n') || 'Нет' },
      { label: 'Недостающий контекст', value: payload.missingContext?.join('\n') || 'Нет' },
    ]);
    this.previewVisible.set(true);
  }

  private submit(status: CreateTaskRequestDto['status'] | undefined): void {
    if (!this.canCreateTask()) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.error.set(undefined);
    this.submitting.set(true);
    this.taskApi.createTask({ ...this.buildPayload(), ...(status ? { status } : {}) }).subscribe({
      next: (response) => {
        this.messages.add({
          severity: 'success',
          summary: status === 'ready' ? 'Готовая задача создана' : 'Черновик задачи создан',
        });
        this.router.navigate(['/', response.task.id]);
      },
      error: (error: unknown) => {
        this.error.set(error instanceof Error ? error.message : String(error));
        this.submitting.set(false);
      },
    });
  }

  private buildPayload(): CreateTaskRequestDto {
    const value = this.form.getRawValue();
    const optional = (entry: string): string | undefined => {
      const trimmed = entry.trim();
      return trimmed || undefined;
    };
    return {
      title: value.title.trim(),
      description: value.description.trim(),
      ...(optional(value.humanSummary) ? { humanSummary: optional(value.humanSummary) } : {}),
      ...(optional(value.repositoryName) ? { repositoryName: optional(value.repositoryName) } : {}),
      ...(optional(value.repoPathKey) ? { repoPathKey: optional(value.repoPathKey) } : {}),
      ...(optional(value.baseBranch) ? { baseBranch: optional(value.baseBranch) } : {}),
      ...(optional(value.queue) ? { queue: optional(value.queue) } : {}),
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
