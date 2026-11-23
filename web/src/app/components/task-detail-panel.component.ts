import { DOCUMENT } from '@angular/common';
import { Component, DestroyRef, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { TooltipModule } from 'primeng/tooltip';

import {
  ChildTaskSummaryDto,
  ClarificationQuestionDto,
  TaskDetailDto,
  TaskDetailResponseDto,
  TaskStatusDto,
} from '../models/human-api.dto';
import { SessionService } from '../services/session.service';
import { RepositoryDirectoryService } from '../services/repository-directory.service';
import { TaskApiService } from '../services/task-api.service';
import { TaskCommandName, TaskCommandService } from '../services/task-command.service';
import { TaskConversationService } from '../services/task-conversation.service';
import { TaskDraftEditorComponent, TaskDraftEditorValue } from './task-draft-editor.component';
import {
  CommandPolicy,
  TASK_COMMAND_POLICIES,
  canUseCapability,
  commandVisible,
  formatDate,
  projectGoalPriorityLabel,
  projectGoalPrioritySeverity,
  projectGoalRiskLabel,
  projectGoalRiskSeverity,
  projectGoalStatusLabel,
  projectGoalStatusSeverity,
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
  answer?: PendingAnswer;
  acceptance?: { id: string; revisionNumber: number; title: string; mergeRequestUrl?: string; criteria: string[] };
}

interface PendingAnswer {
  questionId: string;
  body: string;
}

interface DraftSnapshot extends TaskDraftEditorValue {
  id: string;
  revisionNumber: number;
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
    DialogModule,
    MessageModule,
    ProgressSpinnerModule,
    ReactiveFormsModule,
    RouterLink,
    TagModule,
    TaskDraftEditorComponent,
    TextareaModule,
    TooltipModule,
  ],
  template: `
    <section class="detail-panel" data-testid="detail-panel" [class.detail-panel--page]="fullPage">
      @if (!currentTaskId()) {
        <div class="empty-state surface">
          <i class="pi pi-file-edit" aria-hidden="true"></i>
          <h2>Выберите задачу</h2>
          <p>В карточке доступны ход выполнения, вопросы и действия по задаче.</p>
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
                @if (fullPage) {
                  <h1 tabindex="-1" data-testid="task-title">{{ response.task.title }}</h1>
                } @else {
                  <h2 tabindex="-1" data-testid="task-title">{{ response.task.title }}</h2>
                }
                <div class="tag-row">
                  <p-tag [value]="statusLabel(response.task.status)" [severity]="statusSeverity(response.task.status)" />
                  @if (response.task.repositoryName) {
                    <p-tag [value]="repositories.repoLabel(response.task.repositoryName)" severity="secondary" />
                  }
                  @if (response.task.queue) {
                    <p-tag [value]="response.task.queue" severity="secondary" />
                  }
                  @if (response.task.priority) {
                    <p-tag [value]="priorityLabel(response.task.priority)" [severity]="prioritySeverity(response.task.priority)" />
                  }
                </div>
              </div>

              <div class="action-bar" aria-label="Действия с задачей">
                @if (canEditDraft(response.task)) {
                  <button pButton type="button" data-testid="edit-task-draft" icon="pi pi-pencil"
                    label="Редактировать черновик" severity="secondary" size="small" [disabled]="submitting()"
                    (click)="openDraftEditor(response.task)"></button>
                }
                <button
                  pButton
                  type="button"
                  data-testid="preview-context-button"
                  icon="pi pi-eye"
                  label="Контекст агента"
                  severity="secondary"
                  [text]="true"
                  size="small"
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
                    [text]="true"
                    size="small"
                    [pTooltip]="policy.help"
                    tooltipPosition="bottom"
                    [disabled]="submitting()"
                    (click)="openCommand(policy)"
                  ></button>
                }
              </div>
            </header>

            @if (response.task.status === 'human_testing') {
              <section class="surface stack task-acceptance" aria-labelledby="task-acceptance-title">
                <h3 id="task-acceptance-title">Ожидает приёмки</h3>
                @if (response.latestMergeRequest?.url || response.task.mergeRequestUrl; as mergeRequestUrl) {
                  <a class="external-link" [href]="mergeRequestUrl" target="_blank" rel="noreferrer">
                    Открыть Merge Request <i class="pi pi-external-link" aria-hidden="true"></i>
                  </a>
                }
                @if (response.task.acceptanceCriteria.length) {
                  <ul class="compact-list">
                    @for (criterion of response.task.acceptanceCriteria; track $index) { <li>{{ criterion }}</li> }
                  </ul>
                }
                @if (canAcceptTask(response.task)) {
                  <button pButton type="button" data-testid="command-accept-result" icon="pi pi-check"
                    label="Принять результат" [disabled]="submitting()" (click)="openAcceptance(response)"></button>
                }
              </section>
            }

            @if (openQuestions().length > 0) {
              <section class="surface stack task-questions" aria-labelledby="task-questions-title">
                <h3 id="task-questions-title">{{ openQuestions().length === 1 ? 'Открытый вопрос' : 'Открытые вопросы' }}</h3>
                @for (question of openQuestions(); track question.id) {
                  <div class="question-block" [class.question-block--active]="currentQuestion()?.id === question.id && canAnswer()">
                    <div class="question-block__body">
                      @if (question.summary) { <strong>{{ question.summary }}</strong> }
                      <p class="prewrap">{{ question.question }}</p>
                      @if (question.blockingReason) {
                        <span class="muted">{{ question.blockingReason }}</span>
                      }
                    </div>
                    @if (question.options?.length) {
                      <div class="tag-row">
                        @for (option of question.options; track option) {
                          @if (canAnswer()) {
                            <button pButton type="button" [attr.data-testid]="'answer-option-' + option"
                              [label]="option" severity="secondary" size="small" (click)="selectQuestion(question, option)"></button>
                          } @else {
                            <p-tag [value]="option" severity="secondary" />
                          }
                        }
                      </div>
                    }
                    @if (canAnswer()) {
                      @if (currentQuestion()?.id === question.id) {
                        <div class="answer-grid" id="task-answer-form">
                          <label class="field" for="task-answer">
                            <span>Ваш ответ</span>
                            <textarea pTextarea id="task-answer" data-testid="answer-textarea" rows="3"
                              [formControl]="answerControl" placeholder="Введите ответ"></textarea>
                          </label>
                          <div class="action-bar">
                            <button pButton type="button" data-testid="answer-button" label="Ответить"
                              icon="pi pi-reply" [disabled]="answerControl.invalid || submitting()" (click)="submitAnswer(false)"></button>
                            <button pButton type="button" data-testid="answer-resume-button" label="Ответить и продолжить"
                              icon="pi pi-play" severity="secondary" [disabled]="answerControl.invalid || submitting()"
                              (click)="confirmAnswerResume()"></button>
                          </div>
                        </div>
                      } @else {
                        <button pButton type="button" label="Ответить на этот вопрос" severity="secondary" [text]="true"
                          size="small" (click)="selectQuestion(question)"></button>
                      }
                    }
                  </div>
                }
              </section>
            } @else if (response.task.blockerReason) {
              <section class="surface stack task-questions">
                <h3>Причина остановки</h3>
                <p class="prewrap">{{ response.task.blockerReason }}</p>
              </section>
            }

            <div class="detail-grid">
              <section class="surface stack">
                <h3>О задаче</h3>
                @if (response.task.humanSummary) {
                  <p class="lead">{{ response.task.humanSummary }}</p>
                }
                <p class="prewrap">{{ response.task.description || 'Описание не указано.' }}</p>

                @if (response.task.acceptanceCriteria.length > 0) {
                  <h4>Критерии приемки</h4>
                  <ul class="compact-list">
                    @for (criterion of response.task.acceptanceCriteria; track $index) {
                      <li>{{ criterion }}</li>
                    }
                  </ul>
                }

                @if (response.task.constraints.length || response.task.riskFactors.length || response.task.missingContext.length) {
                  <details class="task-context">
                    <summary>Ограничения, риски и контекст</summary>
                    @if (response.task.constraints.length) {
                      <h4>Ограничения</h4>
                      <ul class="compact-list">
                        @for (constraint of response.task.constraints; track $index) { <li>{{ constraint }}</li> }
                      </ul>
                    }
                    @if (response.task.riskFactors.length) {
                      <h4>Риски</h4>
                      <ul class="compact-list">
                        @for (risk of response.task.riskFactors; track $index) { <li>{{ risk }}</li> }
                      </ul>
                    }
                    @if (response.task.missingContext.length) {
                      <h4>Недостающий контекст</h4>
                      <ul class="compact-list">
                        @for (item of response.task.missingContext; track $index) { <li>{{ item }}</li> }
                      </ul>
                    }
                  </details>
                }

                <div class="field-grid">
                  <div>
                    <span class="field-label">Репозиторий</span>
                    <span>{{ response.task.repositoryName ? repositories.repoLabel(response.task.repositoryName) : 'Не назначено' }}</span>
                  </div>
                  @if (response.task.repoPathKey && response.task.repoPathKey !== response.task.repositoryName) {
                    <div>
                      <span class="field-label">Ключ пути репозитория</span>
                      <span>{{ response.task.repoPathKey }}</span>
                    </div>
                  }
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
                          @if (goal.desiredOutcome) {
                            <span>{{ truncate(goal.desiredOutcome, 220) }}</span>
                          }
                          <span class="tag-row tag-row--compact">
                            <p-tag [value]="goalStatusLabel(goal.status)" [severity]="goalStatusSeverity(goal.status)" />
                            <p-tag [value]="'Приоритет: ' + priorityLabel(goal.priority)" [severity]="prioritySeverity(goal.priority)" />
                            <p-tag [value]="'Риск: ' + riskLabel(goal.riskLevel)" [severity]="riskSeverity(goal.riskLevel)" />
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
                  <p class="muted">Задача сейчас не выполняется воркером.</p>
                }

                @if (response.task.latestAiSummary) {
                  <div>
                    <h4>Последний отчёт агента</h4>
                    <p class="prewrap">{{ response.task.latestAiSummary }}</p>
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
                      <p class="prewrap">{{ response.latestValidation.summary || response.latestValidation.diagnostic }}</p>
                      <span class="muted">{{ formatDate(response.latestValidation.createdAt) }}</span>
                    } @else {
                      <p class="prewrap">{{ response.task.latestValidationSummary }}</p>
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
                        <p class="prewrap">{{ comment.body }}</p>
                      </div>
                    }
                    @for (answer of response.task.humanAnswers; track answer.id) {
                      <div class="timeline-item" data-testid="task-saved-answer">
                        <div class="timeline-item__meta">
                          <strong>{{ answer.author?.displayName || answer.author?.id || 'Ответ пользователя' }}</strong>
                          <time [attr.datetime]="answer.createdAt">{{ formatDate(answer.createdAt) }}</time>
                        </div>
                        @if (answeredQuestions().get(answer.questionId || ''); as question) {
                          <p class="muted">{{ question.summary || question.question }}</p>
                        }
                        <p class="prewrap">{{ answer.body }}</p>
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

    @if (draftSnapshot(); as draft) {
      <app-task-draft-editor [initial]="draft" [stale]="draftStale()" [saving]="submitting()" [error]="draftError()"
        (save)="saveDraft($event)" (cancel)="closeDraftEditor()" />
    }

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
      (visibleChange)="!$event && closeCommandDialog()"
      [modal]="true"
      [closable]="!submitting()"
      [closeOnEscape]="!submitting()"
      [style]="{ width: 'min(560px, 94vw)' }"
    >
      <div data-testid="command-dialog">
      @if (pendingCommand(); as command) {
        <div class="stack">
          <p>{{ command.help }}</p>
          @if (command.child) {
            <p class="muted">Дочерняя задача: {{ command.child.title }}</p>
          }
          @if (command.answer; as answer) {
            <p class="prewrap">{{ answer.body }}</p>
          }
          @if (command.acceptance; as acceptance) {
            <div class="acceptance-context">
              <strong>{{ acceptance.title }}</strong>
              @if (acceptance.mergeRequestUrl) {
                <a class="external-link" [href]="acceptance.mergeRequestUrl" target="_blank" rel="noreferrer">
                  Открыть Merge Request <i class="pi pi-external-link" aria-hidden="true"></i>
                </a>
              }
              @if (acceptance.criteria.length) {
                <ul class="compact-list">
                  @for (criterion of acceptance.criteria; track $index) { <li>{{ criterion }}</li> }
                </ul>
              }
            </div>
            @if (acceptanceStale()) {
              <p-message severity="warn" text="Задача изменилась. Закройте окно, проверьте актуальные критерии и откройте приёмку заново."
                data-testid="acceptance-stale" />
            } @else if (acceptanceError(); as message) {
              <p-message severity="error" [text]="message" data-testid="acceptance-error" />
            }
          }
          <label class="field">
            <span>
              {{ command.acceptance ? 'Итог проверки' : 'Причина' }}
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
              [placeholder]="command.acceptance ? 'Укажите, что проверили и с каким результатом' : 'Укажите рабочую причину'"
            ></textarea>
          </label>
          <div class="action-bar action-bar--end">
            <button
              pButton
              type="button"
              data-testid="command-cancel"
              label="Отмена"
              severity="secondary"
              [disabled]="submitting()"
              (click)="closeCommandDialog()"
            ></button>
            <button
              pButton
              type="button"
              data-testid="command-confirm"
              [label]="command.acceptance ? 'Подтвердить приёмку' : 'Подтвердить'"
              icon="pi pi-check"
              [disabled]="reasonMissing() || submitting() || acceptanceRefreshing() || acceptanceStale()"
              (click)="submitPendingCommand()"
            ></button>
          </div>
        </div>
      }
      </div>
    </p-dialog>
  `,
  styles: `
    :host, .detail-panel, .workflow-detail, .detail-header__title { display: grid; min-width: 0; }
    .detail-panel, .workflow-detail { gap: 14px; }
    .detail-header { display: grid; gap: 14px; }
    .detail-header__title { gap: 8px; }
    .detail-header h1, .detail-header h2 {
      margin: 0;
      overflow-wrap: anywhere;
      font-size: clamp(1.2rem, 2vw, 1.65rem);
      line-height: 1.25;
    }
    .detail-header .action-bar {
      border-top: 1px solid var(--console-border);
      padding-top: 8px;
    }
    .detail-grid { grid-template-columns: minmax(0, 1fr); }
    .detail-panel--page .detail-grid { grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); }
    .detail-grid > section, .field-grid > div { min-width: 0; overflow-wrap: anywhere; }
    .task-questions { border-inline-start: 3px solid #a35709; }
    .task-acceptance { border-inline-start: 3px solid var(--console-focus); overflow-wrap: anywhere; }
    .task-acceptance > button, .task-acceptance > a { justify-self: start; }
    .acceptance-context { display: grid; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
    .question-block {
      padding: 12px;
      border: 1px solid var(--console-border);
      border-radius: 8px;
    }
    .question-block--active, .task-context { background: var(--console-panel-muted); }
    .question-block__body { display: grid; gap: 4px; overflow-wrap: anywhere; }
    .question-block > button { justify-self: start; }
    .task-context { border-radius: 8px; padding: 8px 10px; }
    .task-context summary { cursor: pointer; font-weight: 600; }
    .task-context h4 { margin-block-start: 8px; }
    .eyebrow, .tag-row, .lease-row, .timeline-item__meta { overflow-wrap: anywhere; }
    @media (max-width: 980px) {
      .detail-panel--page .detail-grid { grid-template-columns: minmax(0, 1fr); }
    }
  `,
})
export class TaskDetailPanelComponent {
  private readonly taskApi = inject(TaskApiService);
  private readonly commandApi = inject(TaskCommandService);
  private readonly conversationApi = inject(TaskConversationService);
  private readonly session = inject(SessionService);
  protected readonly repositories = inject(RepositoryDirectoryService);
  private readonly messages = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly answerDrafts = new Map<string, string>();
  private detailRequest: Subscription | undefined;
  private contextRequest: Subscription | undefined;

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
  protected readonly acceptanceError = signal<string | undefined>(undefined);
  protected readonly acceptanceRefreshing = signal(false);
  protected readonly acceptanceStale = computed(() => {
    const acceptance = this.pendingCommand()?.acceptance;
    const task = this.detail()?.task;
    return !!acceptance && (task?.id !== acceptance.id || task.status !== 'human_testing' ||
      task.revisionNumber !== acceptance.revisionNumber);
  });
  protected readonly draftSnapshot = signal<DraftSnapshot | undefined>(undefined);
  protected readonly draftError = signal<string | undefined>(undefined);
  protected readonly draftStale = computed(() => {
    const draft = this.draftSnapshot();
    const task = this.detail()?.task;
    return !!draft && (task?.id !== draft.id || task.status !== 'new' || task.revisionNumber !== draft.revisionNumber);
  });
  protected readonly reasonControl = new FormControl<string>('', { nonNullable: true });
  protected readonly answerControl = new FormControl<string>('', {
    nonNullable: true,
    validators: [(control) => control.value.trim().length >= 2 ? null : { minlength: true }],
  });
  private readonly selectedQuestionId = signal<string | undefined>(undefined);
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
  protected readonly currentQuestion = computed<ClarificationQuestionDto | undefined>(() => {
    const questions = this.openQuestions();
    return questions.find((question) => question.id === this.selectedQuestionId()) ?? questions[0];
  });
  protected readonly answeredQuestions = computed(() =>
    new Map((this.detail()?.task.clarificationQuestions ?? []).map((question) => [question.id, question])),
  );

  @Input() set taskId(value: string | null | undefined) {
    const next = value ?? '';
    if (next === this.currentTaskId()) {
      return;
    }
    this.detailRequest?.unsubscribe();
    this.contextRequest?.unsubscribe();
    this.contextVisible.set(false);
    this.closeCommandDialog(false);
    this.closeDraftEditor(false);
    this.submitting.set(false);
    this.currentTaskId.set(next);
    this.detail.set(undefined);
    this.error.set(undefined);
    this.loading.set(false);
    this.selectedQuestionId.set(undefined);
    this.answerDrafts.clear();
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
    this.detailRequest?.unsubscribe();
    this.error.set(undefined);
    this.detailRequest = this.taskApi.getTask(taskId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        const previousQuestion = this.currentQuestion()?.id;
        this.detail.set(response);
        this.acceptanceRefreshing.set(false);
        const nextQuestion = this.currentQuestion()?.id;
        if (previousQuestion !== nextQuestion) {
          this.selectedQuestionId.set(nextQuestion);
          this.restoreAnswerDraft(nextQuestion);
        }
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
    return projectGoalStatusLabel(status);
  }

  protected goalStatusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalStatusSeverity(status);
  }

  protected priorityLabel(priority: string): string {
    return projectGoalPriorityLabel(priority);
  }

  protected prioritySeverity(priority: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalPrioritySeverity(priority);
  }

  protected riskLabel(riskLevel: string): string {
    return projectGoalRiskLabel(riskLevel);
  }

  protected riskSeverity(riskLevel: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return projectGoalRiskSeverity(riskLevel);
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

  protected canEditDraft(task: TaskDetailDto): boolean {
    return task.status === 'new' && typeof task.revisionNumber === 'number' &&
      canUseCapability(this.session.session(), 'canUpdateTask');
  }

  protected openDraftEditor(task: TaskDetailDto): void {
    if (!this.canEditDraft(task) || task.revisionNumber === undefined || this.submitting()) {
      return;
    }
    const { id, revisionNumber, title, description, acceptanceCriteria } = task;
    this.draftError.set(undefined);
    this.draftSnapshot.set({ id, revisionNumber, title, description, acceptanceCriteria });
  }

  protected closeDraftEditor(restoreFocus = true): void {
    const wasOpen = !!this.draftSnapshot();
    this.draftSnapshot.set(undefined);
    this.draftError.set(undefined);
    if (restoreFocus && wasOpen) {
      this.focusAfterRender('edit-task-draft');
    }
  }

  protected saveDraft(value: TaskDraftEditorValue): void {
    const draft = this.draftSnapshot();
    const task = this.detail()?.task;
    if (!draft || !task || !this.canEditDraft(task) || this.draftStale() || this.submitting()) {
      return;
    }
    this.draftError.set(undefined);
    this.submitting.set(true);
    this.taskApi
      .updateDraftRevision(draft.id, { ...value, expectedRevisionNumber: draft.revisionNumber, expectedStatus: 'new' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ task: savedTask }) => {
          if (this.draftSnapshot() === draft) {
            this.applySavedTask(savedTask);
            this.closeDraftEditor();
          }
          this.afterMutation(draft.id, 'Изменения черновика сохранены.');
        },
        error: (error: unknown) => {
          if (this.draftSnapshot() === draft) {
            this.submitting.set(false);
            this.draftError.set(error instanceof Error ? error.message : String(error));
            this.reload();
          }
        },
      });
  }

  protected canAcceptTask(task: TaskDetailDto): boolean {
    const revision = task.revisionNumber;
    return task.status === 'human_testing' && typeof revision === 'number' &&
      Number.isSafeInteger(revision) && revision >= 1 &&
      canUseCapability(this.session.session(), 'canAcceptTask');
  }

  protected openAcceptance(response: TaskDetailResponseDto): void {
    const task = response.task;
    if (task.revisionNumber === undefined || !this.canAcceptTask(task) || this.submitting()) {
      return;
    }
    this.pendingCommand.set({
      command: 'accept-result',
      label: 'Принять результат',
      reason: 'required',
      help: 'Подтвердите, что результат проверен по критериям задачи.',
      acceptance: {
        id: task.id,
        revisionNumber: task.revisionNumber,
        title: task.title,
        mergeRequestUrl: response.latestMergeRequest?.url || task.mergeRequestUrl,
        criteria: [...task.acceptanceCriteria],
      },
    });
    this.acceptanceError.set(undefined);
    this.reasonControl.reset('');
    this.commandVisibleDialog.set(true);
    this.focusCommandReason();
  }

  protected canApproveDecomposition(): boolean {
    return canUseCapability(this.session.session(), 'canApproveDecomposition');
  }

  protected selectQuestion(question: ClarificationQuestionDto, option?: string): void {
    const previous = this.currentQuestion()?.id;
    if (previous && previous !== question.id) {
      this.answerDrafts.set(previous, this.answerControl.value);
      this.restoreAnswerDraft(question.id);
    }
    this.selectedQuestionId.set(question.id);
    if (option !== undefined) {
      this.answerControl.setValue(option);
      this.answerControl.markAsDirty();
    }
    this.document.defaultView?.requestAnimationFrame(() => this.document.getElementById('task-answer')?.focus());
  }

  protected submitAnswer(resume: boolean): void {
    const answer = this.captureAnswer();
    if (!answer) {
      return;
    }
    if (resume) {
      this.openAnswerResumeDialog(answer);
      return;
    }
    this.postAnswer(answer, false);
  }

  protected confirmAnswerResume(): void {
    this.submitAnswer(true);
  }

  protected openAgentContext(): void {
    const taskId = this.currentTaskId();
    if (!taskId) {
      return;
    }
    this.contextRequest?.unsubscribe();
    this.contextVisible.set(true);
    this.contextLoading.set(true);
    this.contextError.set(undefined);
    this.contextRequest = this.taskApi.getAgentContextPreview(taskId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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

  protected closeCommandDialog(restoreFocus = true): void {
    const acceptanceWasOpen = !!this.pendingCommand()?.acceptance;
    this.commandVisibleDialog.set(false);
    this.pendingCommand.set(undefined);
    this.acceptanceError.set(undefined);
    this.acceptanceRefreshing.set(false);
    this.reasonControl.reset('');
    if (restoreFocus && acceptanceWasOpen) {
      this.focusAfterRender('task-title');
    }
  }

  protected submitPendingCommand(): void {
    const pending = this.pendingCommand();
    const taskId = this.currentTaskId();
    const task = this.detail()?.task;
    if (
      !pending || !taskId || this.reasonMissing() || this.submitting() ||
      (pending.acceptance && (this.acceptanceRefreshing() || this.acceptanceStale() || !task || !this.canAcceptTask(task)))
    ) {
      this.reasonControl.markAsTouched();
      return;
    }
    if (pending.answer) {
      this.postAnswer(pending.answer, true);
      return;
    }
    const reason = this.reasonControl.value.trim();
    this.acceptanceError.set(undefined);
    this.submitting.set(true);
    this.commandApi
      .run(taskId, pending.command, {
        ...(reason ? { reason } : {}),
        ...(pending.acceptance ? {
          expectedStatus: 'human_testing' as const,
          expectedRevisionNumber: pending.acceptance.revisionNumber,
        } : {}),
        ...(pending.command === 'approve-decomposition' ? { approve: true } : {}),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ task: savedTask }) => {
          if (pending.acceptance) {
            this.applySavedTask(savedTask);
          }
          this.afterMutation(taskId, pending.acceptance ? 'Результат принят.' : `${pending.label}: выполнено.`);
        },
        error: (error: unknown) => {
          if (!pending.acceptance) {
            this.afterMutationError(taskId, error);
          } else if (this.pendingCommand() === pending) {
            this.submitting.set(false);
            this.acceptanceError.set(error instanceof Error ? error.message : String(error));
            this.acceptanceRefreshing.set(true);
            this.reload();
          }
        },
      });
  }

  private openAnswerResumeDialog(answer: PendingAnswer): void {
    this.pendingCommand.set({
      command: 'resume',
      label: 'Ответить и продолжить',
      reason: 'recommended',
      help: 'Записывает ответ вместе с командой возобновления, чтобы выполнение продолжилось.',
      answer,
    });
    this.reasonControl.reset('');
    this.commandVisibleDialog.set(true);
    this.focusCommandReason();
  }

  private focusCommandReason(): void {
    setTimeout(() => {
      this.document.querySelector<HTMLTextAreaElement>('[data-testid="command-reason"]')?.focus();
    });
  }

  private focusAfterRender(testId: string): void {
    this.document.defaultView?.requestAnimationFrame(() => {
      if (this.destroyRef.destroyed) {
        return;
      }
      const target = this.document.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ??
        this.document.querySelector<HTMLElement>('[data-testid="task-title"]');
      target?.focus();
    });
  }

  private captureAnswer(): PendingAnswer | undefined {
    const question = this.currentQuestion();
    if (!question || this.answerControl.invalid || !this.currentTaskId() || this.submitting()) {
      this.answerControl.markAsTouched();
      return undefined;
    }
    return { questionId: question.id, body: this.answerControl.value.trim() };
  }

  private restoreAnswerDraft(questionId: string | undefined): void {
    this.answerControl.reset(questionId ? this.answerDrafts.get(questionId) ?? '' : '');
  }

  private applySavedTask(task: TaskDetailDto): void {
    if (task.id === this.currentTaskId()) {
      this.detail.update((detail) => detail && { ...detail, task });
    }
  }

  private postAnswer(answer: PendingAnswer, includeResume: boolean): void {
    const taskId = this.currentTaskId();
    const reason = this.reasonControl.value.trim();
    this.submitting.set(true);
    this.conversationApi
      .answer(taskId, {
        ...answer,
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
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.afterMutation(
          taskId,
          includeResume ? 'Ответ записан, возобновление запрошено.' : 'Ответ записан.',
          answer.questionId,
        ),
        error: (error: unknown) => this.afterMutationError(taskId, error),
      });
  }

  private afterMutation(taskId: string, summary: string, questionId?: string): void {
    this.messages.add({ severity: 'success', summary });
    if (taskId === this.currentTaskId()) {
      this.submitting.set(false);
      this.closeCommandDialog();
      if (questionId) {
        this.answerDrafts.delete(questionId);
        if (this.currentQuestion()?.id === questionId) {
          this.answerControl.reset('');
        }
      }
      this.reload();
    }
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
      if (this.document.visibilityState !== 'hidden' && this.detailRequest?.closed !== false) {
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

  private afterMutationError(taskId: string, error: unknown): void {
    this.messages.add({
      severity: 'error',
      summary: 'Действие не выполнено',
      detail: error instanceof Error ? error.message : String(error),
    });
    if (taskId === this.currentTaskId()) {
      this.submitting.set(false);
    }
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
