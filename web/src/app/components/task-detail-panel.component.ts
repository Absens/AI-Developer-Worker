import { CommonModule } from '@angular/common';
import { Component, DestroyRef, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { DividerModule } from 'primeng/divider';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { TooltipModule } from 'primeng/tooltip';

import {
  ChildTaskSummaryDto,
  ClarificationQuestionDto,
  TaskDetailResponseDto,
  TaskStatusDto,
} from '../models/human-api.dto';
import { SessionService } from '../services/session.service';
import { TaskApiService } from '../services/task-api.service';
import { TaskCommandName, TaskCommandService } from '../services/task-command.service';
import { TaskConversationService } from '../services/task-conversation.service';
import {
  CommandPolicy,
  TASK_COMMAND_POLICIES,
  canUseCapability,
  commandVisible,
  formatDate,
  statusLabel,
  statusSeverity,
  truncate,
} from '../utils/task-ui';

interface PreviewRow {
  label: string;
  value: string;
  wide?: boolean;
}

interface PendingCommand {
  command: TaskCommandName;
  label: string;
  reason: CommandPolicy['reason'];
  help: string;
  child?: ChildTaskSummaryDto;
}

const POLL_INTERVAL_MS = 15_000;
const ACTIVE_DETAIL_STATUSES = new Set<TaskStatusDto>([
  'claimed',
  'analyzing',
  'awaiting_human',
  'decomposing',
  'implementing',
  'validating',
  'review',
  'human_testing',
  'fixing_review',
]);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const arrayText = (value: unknown): string | undefined =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .join('\n')
    : undefined;

@Component({
  selector: 'app-task-detail-panel',
  imports: [
    ButtonModule,
    CommonModule,
    DialogModule,
    DividerModule,
    MessageModule,
    ProgressSpinnerModule,
    ReactiveFormsModule,
    RouterLink,
    SelectModule,
    TagModule,
    TextareaModule,
    TooltipModule,
  ],
  template: `
    <section class="detail-panel" data-testid="detail-panel" [class.detail-panel--page]="fullPage">
      @if (!currentTaskId()) {
        <div class="empty-state">
          <i class="pi pi-file-edit" aria-hidden="true"></i>
          <h2>Выберите задачу</h2>
          <p>Откройте задачу из очереди, чтобы проверить контекст, валидацию, состояние MR и рабочие действия.</p>
        </div>
      } @else {
        @if (loading()) {
          <div class="loading-row" aria-live="polite">
            <p-progressSpinner ariaLabel="Загрузка задачи" />
            <span>Загрузка деталей задачи</span>
          </div>
        }

        @if (error(); as message) {
          <p-message severity="error" [text]="message" />
          <button
            pButton
            type="button"
            icon="pi pi-refresh"
            label="Повторить"
            severity="secondary"
            (click)="reload()"
          ></button>
        }

        @if (detail(); as response) {
          <article class="workflow-detail" data-testid="task-detail">
            <header class="detail-header surface">
              <div class="detail-header__title">
                <div class="eyebrow">{{ response.task.id }}</div>
                <h2>{{ response.task.title }}</h2>
                <div class="tag-row">
                  <p-tag [value]="statusLabel(response.task.status)" [severity]="statusSeverity(response.task.status)" />
                  @if (response.task.repositoryName) {
                    <p-tag [value]="response.task.repositoryName" severity="secondary" />
                  }
                  @if (response.task.queue) {
                    <p-tag [value]="response.task.queue" severity="secondary" />
                  }
                  @if (response.task.priority) {
                    <p-tag [value]="response.task.priority" severity="contrast" />
                  }
                </div>
              </div>

              <div class="action-bar" aria-label="Действия с задачей">
                <button
                  pButton
                  type="button"
                  data-testid="preview-context-button"
                  icon="pi pi-eye"
                  label="Предпросмотр контекста"
                  severity="secondary"
                  (click)="openAgentContext()"
                ></button>
                @for (policy of visiblePolicies(response.task.status); track policy.command) {
                  <button
                    pButton
                    type="button"
                    [attr.data-testid]="'command-' + policy.command"
                    [icon]="policy.icon"
                    [label]="policy.label"
                    [severity]="policy.command === 'cancel' ? 'danger' : 'secondary'"
                    [pTooltip]="policy.help"
                    tooltipPosition="bottom"
                    (click)="openCommand(policy)"
                  ></button>
                }
              </div>
            </header>

            <div class="detail-grid">
              <section class="surface stack">
                <h3>Цель</h3>
                @if (response.task.humanSummary) {
                  <p class="lead">{{ response.task.humanSummary }}</p>
                }
                <p class="prewrap">{{ response.task.description || 'Описание не указано.' }}</p>

                @if (response.task.acceptanceCriteria.length > 0) {
                  <h4>Критерии приемки</h4>
                  <ul class="compact-list">
                    @for (criterion of response.task.acceptanceCriteria; track criterion) {
                      <li>{{ criterion }}</li>
                    }
                  </ul>
                }

                <div class="field-grid">
                  <div>
                    <span class="field-label">Репозиторий</span>
                    <span>{{ response.task.repositoryName || 'Не назначено' }}</span>
                  </div>
                  <div>
                    <span class="field-label">Ключ пути репозитория</span>
                    <span>{{ response.task.repoPathKey || 'Не назначено' }}</span>
                  </div>
                  <div>
                    <span class="field-label">Базовая ветка</span>
                    <span>{{ response.task.baseBranch || 'По умолчанию' }}</span>
                  </div>
                  <div>
                    <span class="field-label">Обновлено</span>
                    <span>{{ formatDate(response.task.updatedAt) }}</span>
                  </div>
                </div>

                @if (response.task.tags?.length) {
                  <div class="tag-row">
                    @for (tag of response.task.tags; track tag) {
                      <p-tag [value]="tag" severity="secondary" />
                    }
                  </div>
                }

                @if (response.projectGoals?.length) {
                  <div class="summary-block task-project-goals" data-testid="task-project-goals">
                    <h4>Цели проекта</h4>
                    <div class="goal-badge-list">
                      @for (goal of response.projectGoals; track goal.id) {
                        <a class="goal-badge" [routerLink]="['/goals', goal.id]">
                          <span class="goal-badge__title">{{ goal.title }}</span>
                          <span class="tag-row tag-row--compact">
                            <p-tag [value]="goalStatusLabel(goal.status)" [severity]="goalStatusSeverity(goal.status)" />
                            <p-tag [value]="'Риск: ' + goal.riskLevel" [severity]="riskSeverity(goal.riskLevel)" />
                          </span>
                        </a>
                      }
                    </div>
                  </div>
                }
              </section>

              <section class="surface stack">
                <h3>Выполнение</h3>
                @if (response.activeLeases.length > 0) {
                  <div class="lease-list">
                    @for (lease of response.activeLeases; track lease.id) {
                      <div class="lease-row">
                        <div>
                          <strong>{{ lease.workerId }}</strong>
                          <span>{{ lease.kind }}</span>
                        </div>
                        <span>истекает {{ formatDate(lease.expiresAt) }}</span>
                      </div>
                    }
                  </div>
                } @else {
                  <p class="muted">Нет активных аренд.</p>
                }

                @if (response.task.latestAiSummary) {
                  <div>
                    <h4>Последнее резюме AI</h4>
                    <p>{{ truncate(response.task.latestAiSummary, 360) }}</p>
                  </div>
                }

                @if (response.latestValidation || response.task.latestValidationSummary) {
                  <div class="summary-block">
                    <h4>Валидация</h4>
                    @if (response.latestValidation) {
                      <p-tag
                        [value]="response.latestValidation.status || 'неизвестно'"
                        [severity]="response.latestValidation.status === 'passed' ? 'success' : 'danger'"
                      />
                      <p>{{ truncate(response.latestValidation.summary || response.latestValidation.diagnostic, 360) }}</p>
                      <span class="muted">{{ formatDate(response.latestValidation.createdAt) }}</span>
                    } @else {
                      <p>{{ truncate(response.task.latestValidationSummary, 360) }}</p>
                    }
                  </div>
                }

                @if (response.latestMergeRequest || response.task.mergeRequestUrl) {
                  <div class="summary-block">
                    <h4>Merge Request</h4>
                    @if (response.latestMergeRequest?.url || response.task.mergeRequestUrl) {
                      <a
                        class="external-link"
                        [href]="response.latestMergeRequest?.url || response.task.mergeRequestUrl"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {{ response.latestMergeRequest?.title || response.task.mergeRequestUrl }}
                        <i class="pi pi-external-link" aria-hidden="true"></i>
                      </a>
                    }
                    <div class="field-grid field-grid--compact">
                      <div>
                        <span class="field-label">Ветка</span>
                        <span>{{ response.latestMergeRequest?.branch || response.task.branch || 'Неизвестно' }}</span>
                      </div>
                      <div>
                        <span class="field-label">Результат</span>
                        <span>{{ response.latestMergeRequest?.outcome || 'Неизвестно' }}</span>
                      </div>
                    </div>
                  </div>
                }

                @if (response.diagnostics.repeatedValidationFailures > 0) {
                  <p-message
                    severity="warn"
                    [text]="'Повторные ошибки валидации: ' + response.diagnostics.repeatedValidationFailures"
                  />
                }
              </section>
            </div>

            @if (openQuestions().length > 0) {
              <section class="surface stack">
                <h3>Открытый вопрос</h3>
                @for (question of openQuestions(); track question.id) {
                  <div class="question-block">
                    <div class="question-block__body">
                      <strong>{{ question.summary || 'Нужна информация' }}</strong>
                      <p>{{ question.question }}</p>
                      @if (question.blockingReason) {
                        <span class="muted">{{ question.blockingReason }}</span>
                      }
                    </div>
                    @if (question.options?.length) {
                      <div class="tag-row">
                        @for (option of question.options; track option) {
                      <button
                        pButton
                        type="button"
                        [attr.data-testid]="'answer-option-' + option"
                        [label]="option"
                            severity="secondary"
                            size="small"
                            (click)="useAnswerOption(question, option)"
                          ></button>
                        }
                      </div>
                    }
                  </div>
                }

                @if (canAnswer()) {
                  <div class="answer-grid">
                    <textarea
                      pTextarea
                      data-testid="answer-textarea"
                      rows="4"
                      [formControl]="answerControl"
                      placeholder="Ответьте на выбранный вопрос"
                      aria-label="Ответить"
                    ></textarea>
                    <div class="action-bar">
                      <button
                        pButton
                        type="button"
                        data-testid="answer-button"
                        label="Ответить"
                        icon="pi pi-reply"
                        [disabled]="answerControl.invalid || submitting()"
                        (click)="submitAnswer(false)"
                      ></button>
                      <button
                        pButton
                        type="button"
                        data-testid="answer-resume-button"
                        label="Ответить и продолжить"
                        icon="pi pi-play"
                        severity="secondary"
                        [disabled]="answerControl.invalid || submitting()"
                        (click)="confirmAnswerResume()"
                      ></button>
                    </div>
                  </div>
                }
              </section>
            }

            @if (response.children.length > 0) {
              <section class="surface stack">
                <h3>Декомпозиция</h3>
                <div class="child-list">
                  @for (child of response.children; track child.id) {
                    <div class="child-row">
                      <div>
                        <a [routerLink]="['/', child.id]">{{ child.title }}</a>
                        <div class="muted">{{ child.dependencyReason || 'Дочерняя зависимость' }}</div>
                        <div class="tag-row">
                          <p-tag [value]="statusLabel(child.status)" [severity]="statusSeverity(child.status)" />
                          <p-tag [value]="child.externalMirrorStatus || 'internal_only'" severity="secondary" />
                        </div>
                      </div>
                      @if (canApproveDecomposition()) {
                        <button
                          pButton
                          type="button"
                          [attr.data-testid]="'approve-decomposition-' + child.id"
                          label="Одобрить зеркалирование"
                          icon="pi pi-check"
                          severity="secondary"
                          (click)="openDecompositionApproval(child)"
                        ></button>
                      }
                    </div>
                  }
                </div>
              </section>
            }

            <div class="detail-grid">
              <section class="surface stack">
                <h3>Комментарии и ответы</h3>
                @if (response.task.comments.length === 0 && response.task.humanAnswers.length === 0) {
                  <p class="muted">Комментариев и ответов пока нет.</p>
                } @else {
                  <div class="timeline-list">
                    @for (comment of response.task.comments; track comment.id) {
                      <div class="timeline-item">
                        <div class="timeline-item__meta">
                          <strong>{{ comment.author?.displayName || comment.author?.id || 'неизвестно' }}</strong>
                          <span>{{ formatDate(comment.createdAt) }}</span>
                        </div>
                        <p>{{ truncate(comment.body, 500) }}</p>
                      </div>
                    }
                  </div>
                }
              </section>

              <section class="surface stack">
                <h3>Хронология</h3>
                @if (response.task.events.length === 0) {
                  <p class="muted">Событий пока нет.</p>
                } @else {
                  <div class="timeline-list">
                    @for (event of response.task.events; track event.id || event.createdAt + event.kind) {
                      <div class="timeline-item">
                        <div class="timeline-item__meta">
                          <strong>{{ statusLabel(event.kind) }}</strong>
                          <span>{{ formatDate(event.createdAt) }}</span>
                        </div>
                        @if (event.message) {
                          <p>{{ truncate(event.message, 420) }}</p>
                        }
                        @if (event.actor) {
                          <span class="muted">{{ event.actor.displayName || event.actor.id }}</span>
                        }
                      </div>
                    }
                  </div>
                }
              </section>
            </div>
          </article>
        }
      }
    </section>

    <p-dialog
      header="Предпросмотр контекста агента"
      [visible]="contextVisible()"
      (visibleChange)="contextVisible.set($event)"
      [modal]="true"
      [style]="{ width: 'min(860px, 94vw)' }"
      contentStyleClass="dialog-scroll"
    >
      <div data-testid="context-dialog">
      @if (contextLoading()) {
        <div class="loading-row"><p-progressSpinner ariaLabel="Загрузка контекста" /> Загрузка предпросмотра</div>
      } @else if (contextError()) {
        <p-message severity="error" [text]="contextError() || 'Не удалось загрузить контекст'" />
      } @else {
        <p class="muted">
          Показаны разрешенные поля контекста задачи. Длинные значения в предпросмотре сокращены.
        </p>
        <div class="preview-grid">
          @for (row of contextRows(); track row.label) {
            <div class="preview-row" [class.preview-row--wide]="row.wide">
              <span>{{ row.label }}</span>
              <pre>{{ row.value }}</pre>
            </div>
          }
        </div>
      }
      </div>
    </p-dialog>

    <p-dialog
      [header]="pendingCommand()?.label || 'Подтвердите действие'"
      [visible]="commandVisibleDialog()"
      (visibleChange)="commandVisibleDialog.set($event)"
      [modal]="true"
      [style]="{ width: 'min(560px, 94vw)' }"
    >
      <div data-testid="command-dialog">
      @if (pendingCommand(); as command) {
        <div class="stack">
          <p>{{ command.help }}</p>
          @if (command.child) {
            <p class="muted">Child task: {{ command.child.title }}</p>
          }
          <label class="field">
            <span>
              Причина
              @if (command.reason === 'required') {
                <strong aria-label="обязательно">*</strong>
              } @else if (command.reason === 'recommended') {
                <span class="muted">(рекомендуется)</span>
              }
            </span>
            <textarea
              pTextarea
              data-testid="command-reason"
              autofocus
              rows="4"
              [formControl]="reasonControl"
              placeholder="Укажите рабочую причину"
            ></textarea>
          </label>
          <div class="action-bar action-bar--end">
            <button
              pButton
              type="button"
              data-testid="command-cancel"
              label="Отмена"
              severity="secondary"
              (click)="closeCommandDialog()"
            ></button>
            <button
              pButton
              type="button"
              data-testid="command-confirm"
              label="Подтвердить"
              icon="pi pi-check"
              [disabled]="reasonMissing() || submitting()"
              (click)="submitPendingCommand()"
            ></button>
          </div>
        </div>
      }
      </div>
    </p-dialog>
  `,
})
export class TaskDetailPanelComponent {
  private readonly taskApi = inject(TaskApiService);
  private readonly commandApi = inject(TaskCommandService);
  private readonly conversationApi = inject(TaskConversationService);
  private readonly session = inject(SessionService);
  private readonly messages = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  @Input() fullPage = false;
  @Output() taskChanged = new EventEmitter<void>();

  protected readonly currentTaskId = signal('');
  protected readonly detail = signal<TaskDetailResponseDto | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | undefined>(undefined);

  protected readonly contextVisible = signal(false);
  protected readonly contextLoading = signal(false);
  protected readonly contextError = signal<string | undefined>(undefined);
  protected readonly contextRows = signal<PreviewRow[]>([]);

  protected readonly commandVisibleDialog = signal(false);
  protected readonly pendingCommand = signal<PendingCommand | undefined>(undefined);
  protected readonly reasonControl = new FormControl<string>('', { nonNullable: true });
  protected readonly answerControl = new FormControl<string>('', {
    nonNullable: true,
    validators: [Validators.required, Validators.minLength(2)],
  });
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  protected readonly openQuestions = computed(() =>
    (this.detail()?.task.clarificationQuestions ?? []).filter(
      (question) =>
        !this.detail()?.task.humanAnswers.some((answer) => answer.questionId === question.id),
    ),
  );

  @Input() set taskId(value: string | null | undefined) {
    const next = value ?? '';
    if (next === this.currentTaskId()) {
      return;
    }
    this.currentTaskId.set(next);
    this.detail.set(undefined);
    this.error.set(undefined);
    this.answerControl.reset('');
    this.stopPolling();
    if (next) {
      this.reload();
    }
  }

  protected reload(): void {
    const taskId = this.currentTaskId();
    if (!taskId) {
      return;
    }
    if (!this.detail()) {
      this.loading.set(true);
    }
    this.error.set(undefined);
    this.taskApi.getTask(taskId).subscribe({
      next: (response) => {
        this.detail.set(response);
        this.loading.set(false);
        this.syncPolling(response.task.status);
      },
      error: (error: unknown) => {
        this.error.set(error instanceof Error ? error.message : String(error));
        this.loading.set(false);
      },
    });
  }

  protected statusLabel(status: string): string {
    return statusLabel(status);
  }

  protected statusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' {
    return statusSeverity(status);
  }

  protected goalStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      proposed: 'Предложено',
      approved: 'Одобрено',
      active: 'Активно',
      completed: 'Завершено',
      rejected: 'Отклонено',
      stale: 'Устарело',
    };
    return labels[status] ?? status;
  }

  protected goalStatusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (status === 'completed') {
      return 'success';
    }
    if (status === 'active' || status === 'approved') {
      return 'info';
    }
    if (status === 'proposed') {
      return 'warn';
    }
    if (status === 'rejected' || status === 'stale') {
      return 'danger';
    }
    return 'secondary';
  }

  protected riskSeverity(riskLevel: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (riskLevel === 'high') {
      return 'danger';
    }
    if (riskLevel === 'medium') {
      return 'warn';
    }
    return 'success';
  }

  protected formatDate(value: string | undefined): string {
    return formatDate(value);
  }

  protected truncate(value: string | undefined, max?: number): string {
    return truncate(value, max);
  }

  protected visiblePolicies(status: TaskStatusDto): CommandPolicy[] {
    return TASK_COMMAND_POLICIES.filter((policy) => commandVisible(policy, status, this.session.session()));
  }

  protected canAnswer(): boolean {
    return canUseCapability(this.session.session(), 'canAnswer');
  }

  protected canApproveDecomposition(): boolean {
    return canUseCapability(this.session.session(), 'canApproveDecomposition');
  }

  protected useAnswerOption(question: ClarificationQuestionDto, option: string): void {
    this.answerControl.setValue(option);
    this.answerControl.markAsDirty();
    this.answerControl.markAsTouched();
  }

  protected submitAnswer(resume: boolean): void {
    if (this.answerControl.invalid || !this.currentTaskId()) {
      this.answerControl.markAsTouched();
      return;
    }
    if (resume) {
      this.openAnswerResumeDialog();
      return;
    }
    this.postAnswer(false);
  }

  protected confirmAnswerResume(): void {
    if (this.answerControl.invalid) {
      this.answerControl.markAsTouched();
      return;
    }
    this.openAnswerResumeDialog();
  }

  protected openAgentContext(): void {
    const taskId = this.currentTaskId();
    if (!taskId) {
      return;
    }
    this.contextVisible.set(true);
    this.contextLoading.set(true);
    this.contextError.set(undefined);
    this.taskApi.getAgentContextPreview(taskId).subscribe({
      next: (response) => {
        this.contextRows.set(this.safeContextRows(response.agentContext));
        this.contextLoading.set(false);
      },
      error: (error: unknown) => {
        this.contextError.set(error instanceof Error ? error.message : String(error));
        this.contextLoading.set(false);
      },
    });
  }

  protected openCommand(policy: CommandPolicy): void {
    this.pendingCommand.set({
      command: policy.command,
      label: policy.label,
      reason: policy.reason,
      help: policy.help,
    });
    this.reasonControl.reset('');
    this.commandVisibleDialog.set(true);
    this.focusCommandReason();
  }

  protected openDecompositionApproval(child: ChildTaskSummaryDto): void {
    this.pendingCommand.set({
      command: 'approve-decomposition',
      label: 'Одобрить зеркалирование декомпозиции',
      reason: 'required',
      help: 'Записывает одобрение решений по зеркалированию дочерней задачи.',
      child,
    });
    this.reasonControl.reset('');
    this.commandVisibleDialog.set(true);
    this.focusCommandReason();
  }

  protected reasonMissing(): boolean {
    return this.pendingCommand()?.reason === 'required' && !this.reasonControl.value.trim();
  }

  protected closeCommandDialog(): void {
    this.commandVisibleDialog.set(false);
    this.pendingCommand.set(undefined);
    this.reasonControl.reset('');
  }

  protected submitPendingCommand(): void {
    const pending = this.pendingCommand();
    const taskId = this.currentTaskId();
    if (!pending || !taskId || this.reasonMissing()) {
      this.reasonControl.markAsTouched();
      return;
    }
    if (pending.label === 'Ответить и продолжить') {
      this.postAnswer(true);
      return;
    }
    const reason = this.reasonControl.value.trim();
    this.submitting.set(true);
    this.commandApi
      .run(taskId, pending.command, {
        ...(reason ? { reason } : {}),
        ...(pending.command === 'approve-decomposition' ? { approve: true } : {}),
      })
      .subscribe({
        next: () => this.afterMutation(`${pending.label}: выполнено.`),
        error: (error: unknown) => this.afterMutationError(error),
      });
  }

  private openAnswerResumeDialog(): void {
    this.pendingCommand.set({
      command: 'resume',
      label: 'Ответить и продолжить',
      reason: 'recommended',
      help: 'Записывает ответ вместе с командой возобновления, чтобы выполнение продолжилось.',
    });
    this.reasonControl.reset('');
    this.commandVisibleDialog.set(true);
    this.focusCommandReason();
  }

  private focusCommandReason(): void {
    setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('[data-testid="command-reason"]')?.focus();
    });
  }

  private postAnswer(includeResume: boolean): void {
    const question = this.openQuestions()[0];
    const body = this.answerControl.value.trim();
    const reason = this.reasonControl.value.trim();
    this.submitting.set(true);
    this.conversationApi
      .answer(this.currentTaskId(), {
        ...(question ? { questionId: question.id } : {}),
        body,
        ...(includeResume
          ? {
              command: {
                type: 'resume',
                rawText: reason ? `/resume ${reason}` : '/resume',
                ...(reason ? { freeform: reason } : {}),
              },
            }
          : {}),
      })
      .subscribe({
        next: () => this.afterMutation(includeResume ? 'Ответ записан, возобновление запрошено.' : 'Ответ записан.'),
        error: (error: unknown) => this.afterMutationError(error),
      });
  }

  private afterMutation(summary: string): void {
    this.messages.add({ severity: 'success', summary });
    this.submitting.set(false);
    this.closeCommandDialog();
    this.answerControl.reset('');
    this.reload();
    this.taskChanged.emit();
  }

  private syncPolling(status: TaskStatusDto): void {
    if (!ACTIVE_DETAIL_STATUSES.has(status)) {
      this.stopPolling();
      return;
    }
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        this.reload();
      }
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (!this.pollTimer) {
      return;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private afterMutationError(error: unknown): void {
    this.messages.add({
      severity: 'error',
      summary: 'Действие не выполнено',
      detail: error instanceof Error ? error.message : String(error),
    });
    this.submitting.set(false);
  }

  private safeContextRows(value: unknown): PreviewRow[] {
    const raw = record(value);
    const rows: PreviewRow[] = [];
    const add = (label: string, text: unknown, wide = false): void => {
      const valueText =
        Array.isArray(text) || typeof text === 'object'
          ? safeJsonText(text)
          : typeof text === 'string'
            ? text
            : text === undefined || text === null
              ? ''
              : String(text);
      if (valueText.trim()) {
        rows.push({ label, value: truncate(valueText, wide ? 1200 : 360), wide });
      }
    };

    add('ID задачи', raw['taskId']);
    add('Статус', raw['status']);
    add('Название', raw['title']);
    add('Описание', raw['description'], true);
    add('Кратко для человека', raw['humanSummary'], true);
    add('Репозиторий', raw['repositoryName']);
    add('Ключ пути репозитория', raw['repoPathKey']);
    add('Базовая ветка', raw['baseBranch']);
    add('Очередь', raw['queue']);
    add('Приоритет', raw['priority']);
    add('Тип задачи', raw['taskType']);
    add('Профиль промпта', raw['promptProfileId']);
    add('Теги', arrayText(raw['tags']));
    add('Компоненты', arrayText(raw['components']));
    add('Критерии приемки', arrayText(raw['acceptanceCriteria']), true);
    add('Ограничения', arrayText(raw['constraints']), true);
    add('Риски', arrayText(raw['riskFactors']), true);
    add('Недостающий контекст', arrayText(raw['missingContext']), true);

    const activePlan = record(raw['activePlan']);
    if (Object.keys(activePlan).length > 0) {
      add(
        'Активный план',
        {
          status: activePlan['status'],
          steps: Array.isArray(activePlan['steps']) ? activePlan['steps'].length : 0,
          updatedAt: activePlan['updatedAt'],
        },
        true,
      );
    }

    add('Комментарии', Array.isArray(raw['comments']) ? raw['comments'].length : undefined);
    add('События', Array.isArray(raw['events']) ? raw['events'].length : undefined);
    add('Решения', Array.isArray(raw['decisions']) ? raw['decisions'].length : undefined);
    return rows;
  }
}

const safeJsonText = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry : stringValue(record(entry)['summary']) ?? safeJsonText(entry)))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
};
