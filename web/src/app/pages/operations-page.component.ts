import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { distinctUntilChanged, map, Subscription } from 'rxjs';

import {
  OperationTaskDiagnosticDto,
  OperationsSnapshotDto,
  QueueDepthDto,
  TaskSummaryDto,
  WorkerSnapshotDto,
} from '../models/human-api.dto';
import { OperationsService } from '../services/operations.service';
import { RepositoryDirectoryService } from '../services/repository-directory.service';
import { SessionService } from '../services/session.service';
import { TaskCommandName, TaskCommandService } from '../services/task-command.service';
import { canUseCapability, formatDate, statusLabel, statusSeverity, truncate } from '../utils/task-ui';

const POLL_INTERVAL_MS = 15_000;
const HEARTBEAT_WARNING_SECONDS = 60;
const HEARTBEAT_ERROR_SECONDS = 300;
const HOLDABLE_STATUSES = new Set([
  'ready',
  'claimed',
  'analyzing',
  'awaiting_human',
  'implementing',
  'validating',
  'review',
  'human_testing',
]);

export type HeartbeatHealth = 'healthy' | 'warning' | 'error' | 'unknown';

interface WorkerRow {
  worker: WorkerSnapshotDto;
  heartbeatAgeSeconds?: number;
  health: HeartbeatHealth;
}

interface OperationsOverview {
  activeWorkers: number;
  readyDepth: number;
  failedTasks: number;
  waitingForHuman: number;
  activeLeases: number;
}

interface OperationsAttentionRow {
  task: TaskSummaryDto;
  kind: 'waiting' | 'failed';
  waitingSince?: number;
  waitingAgeIsApproximate?: boolean;
  repeated: boolean;
}

interface OperationsAttention {
  rows: OperationsAttentionRow[];
  history: TaskSummaryDto[];
}

interface PendingOperationAction {
  task: TaskSummaryDto;
  command: Extract<TaskCommandName, 'retry' | 'hold'>;
  label: string;
}

const timestampForWorker = (worker: WorkerSnapshotDto): string | undefined =>
  worker.lastHeartbeatAt || worker.updatedAt || worker.startedAt;

const parseTime = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
};

export const heartbeatAgeSeconds = (
  worker: WorkerSnapshotDto,
  referenceIso?: string,
): number | undefined => {
  const heartbeat = parseTime(timestampForWorker(worker));
  if (heartbeat === undefined) {
    return undefined;
  }
  const reference = parseTime(referenceIso) ?? Date.now();
  return Math.max(0, Math.floor((reference - heartbeat) / 1000));
};

export const classifyHeartbeat = (
  worker: WorkerSnapshotDto,
  referenceIso?: string,
): HeartbeatHealth => {
  const age = heartbeatAgeSeconds(worker, referenceIso);
  if (age === undefined) {
    return 'unknown';
  }
  if (age > HEARTBEAT_ERROR_SECONDS) {
    return 'error';
  }
  if (age >= HEARTBEAT_WARNING_SECONDS) {
    return 'warning';
  }
  return 'healthy';
};

export const formatDuration = (seconds: number | undefined): string => {
  if (seconds === undefined) {
    return 'Неизвестно';
  }
  if (seconds < 60) {
    return `${seconds} с`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} мин ${seconds % 60} с`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
};

export function buildOperationsAttention(
  snapshot: OperationsSnapshotDto | undefined,
  diagnosticsByTaskId: ReadonlyMap<string, OperationTaskDiagnosticDto>,
): OperationsAttention {
  if (!snapshot) {
    return { rows: [], history: [] };
  }

  const repeated = new Map(snapshot.repeatedFailures.map((task) => [task.id, task]));
  const current = new Map<string, OperationsAttentionRow>();
  for (const task of snapshot.waitingForHuman) {
    const diagnostic = diagnosticsByTaskId.get(task.id);
    const questionTime = parseTime(diagnostic?.waitingSince) ?? parseTime(diagnostic?.latestQuestion?.createdAt);
    current.set(task.id, {
      task,
      kind: 'waiting',
      waitingSince: questionTime ?? parseTime(task.updatedAt),
      waitingAgeIsApproximate: questionTime === undefined,
      repeated: repeated.has(task.id),
    });
  }
  for (const task of [...snapshot.failedTasks, ...repeated.values()]) {
    if (!current.has(task.id) && (task.status === 'failed' || task.status === 'blocked')) {
      current.set(task.id, { task, kind: 'failed', repeated: repeated.has(task.id) });
    }
  }

  const rows = [...current.values()].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'waiting' ? -1 : 1;
    }
    if (left.kind === 'waiting') {
      return (
        (left.waitingSince ?? Number.POSITIVE_INFINITY) -
          (right.waitingSince ?? Number.POSITIVE_INFINITY) ||
        left.task.id.localeCompare(right.task.id)
      );
    }
    return right.task.updatedAt.localeCompare(left.task.updatedAt) || left.task.id.localeCompare(right.task.id);
  });
  const history = [...repeated.values()]
    .filter((task) => !current.has(task.id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  return { rows, history };
}

@Component({
  selector: 'app-operations-page',
  imports: [
    ButtonModule,
    CommonModule,
    DialogModule,
    MessageModule,
    ProgressSpinnerModule,
    ReactiveFormsModule,
    RouterLink,
    TableModule,
    TagModule,
    TextareaModule,
  ],
  template: `
    <section class="page operations-page" data-testid="operations-page">
      <header class="page__header">
        <div>
          <h1>Операции</h1>
          <p>Разберите вопросы и ошибки, затем проверьте состояние исполнителей и очередей.</p>
        </div>
        <div class="operations-header-actions">
          <label class="field operations-project">
            <span>Проект</span>
            <select
              #projectPicker
              data-testid="operations-repository"
              [value]="repository()"
              (change)="selectRepository(projectPicker.value)"
            >
              <option value="">Все проекты</option>
              @for (project of repositories(); track project) {
                <option [value]="project">{{ repoLabel(project) }}</option>
              }
            </select>
          </label>
          <button
            pButton
            type="button"
            aria-label="Обновить операции"
            data-testid="operations-refresh"
            icon="pi pi-refresh"
            label="Обновить"
            severity="secondary"
            [loading]="refreshing()"
            (click)="refreshNow()"
          ></button>
        </div>
      </header>

      @if (snapshot(); as current) {
        <div class="operations-status">
          <span>Снимок от {{ formatDate(current.generatedAt) }}</span>
          @if (refreshError()) {
            <p-tag value="Устаревший снимок" severity="warn" />
            @if (lastRefreshAttempt(); as attempt) {
              <span>Последняя проверка {{ formatDate(attempt) }}</span>
            }
          }
        </div>
      }

      @if (error(); as message) {
        <p-message severity="error" [text]="message" />
      }

      @if (refreshError(); as message) {
        <p-message
          severity="warn"
          [text]="'Показан последний успешный снимок. Ошибка обновления: ' + message"
        />
      }

      @if (loading() && !snapshot()) {
        <div class="loading-row" aria-live="polite">
          <p-progressSpinner ariaLabel="Загрузка операций" />
          <span>Загрузка операций</span>
        </div>
      } @else if (snapshot()) {
        <div class="metric-strip operations-overview">
          <a class="metric operations-metric" routerLink="/" [queryParams]="queueParams('awaiting_human')" data-testid="operation-queue-waiting">
            <span class="metric__label">Ждет человека</span>
            <strong class="metric__value" [class.attention]="overview().waitingForHuman > 0">{{ overview().waitingForHuman }}</strong>
          </a>
          <a class="metric operations-metric" routerLink="/" [queryParams]="queueParams('failed')" data-testid="operation-queue-failed">
            <span class="metric__label">Задачи с ошибкой</span>
            <strong class="metric__value" [class.failure]="overview().failedTasks > 0">{{ overview().failedTasks }}</strong>
          </a>
          <a class="metric operations-metric" routerLink="/" [queryParams]="queueParams('ready')" data-testid="operation-queue-ready">
            <span class="metric__label">Готовая очередь</span>
            <strong class="metric__value">{{ overview().readyDepth }}</strong>
          </a>
          <button type="button" class="metric operations-metric" (click)="focusSection(workersSection)">
            <span class="metric__label">Активные воркеры</span>
            <strong class="metric__value">{{ overview().activeWorkers }}</strong>
          </button>
          <button type="button" class="metric operations-metric" (click)="focusSection(leasesSection)">
            <span class="metric__label">Активные аренды</span>
            <strong class="metric__value">{{ overview().activeLeases }}</strong>
          </button>
        </div>

        <section class="surface operations-section" aria-labelledby="operations-attention-heading">
          <header class="section-header">
            <h2 id="operations-attention-heading">Требуют внимания</h2>
            <p-tag [value]="String(attention().rows.length)" [severity]="attention().rows.length ? 'warn' : 'secondary'" />
          </header>
          <ul class="operation-tasks">
            @for (row of attention().rows; track row.task.id) {
              @let task = row.task;
              <li class="operation-task" [attr.data-testid]="'operation-attention-' + task.id">
                <div class="operation-task__main">
                  <div class="tag-row">
                    <p-tag [value]="statusLabel(task.status)" [severity]="statusSeverity(task.status)" />
                    @if (row.repeated) {
                      <span class="operation-repeat">{{ repeatLabel(task) }}</span>
                    }
                  </div>
                  @if (row.kind === 'waiting') {
                    <strong>{{ task.title }}</strong>
                  } @else {
                    <a [routerLink]="['/', task.id]">{{ task.title }}</a>
                  }
                  <p class="muted">
                    {{ repoLabel(task.repositoryName) }}
                    @if (row.kind === 'waiting') {
                      · {{ waitingTimeLabel(row) }}
                      @if (task.activeWorker) { · {{ task.activeWorker }} }
                    } @else {
                      · {{ formatDate(task.updatedAt) }}
                    }
                  </p>
                  <p>{{ row.kind === 'waiting' ? waitingSummary(task) : diagnosticSummary(task) }}</p>
                </div>
                <div class="row-actions">
                  @if (row.kind === 'waiting') {
                    <a
                      pButton
                      size="small"
                      [routerLink]="['/', task.id]"
                      [attr.data-testid]="'operation-open-waiting-' + task.id"
                      [attr.aria-label]="(canAnswer() ? 'Ответить по задаче ' : 'Открыть задачу ') + task.title"
                      [icon]="canAnswer() ? 'pi pi-reply' : 'pi pi-eye'"
                      [label]="canAnswer() ? 'Ответить' : 'Открыть'"
                    ></a>
                  } @else if (canRetry(task)) {
                    <button
                      pButton
                      type="button"
                      size="small"
                      [attr.data-testid]="'operation-retry-' + task.id"
                      icon="pi pi-refresh"
                      label="Повторить"
                      (click)="openTaskAction(task, 'retry')"
                    ></button>
                  }
                  <button
                    #diagnosticsTrigger
                    pButton
                    type="button"
                    size="small"
                    [attr.data-testid]="'operation-details-' + task.id"
                    icon="pi pi-info-circle"
                    label="Детали"
                    severity="secondary"
                    (click)="openDiagnostics(task, diagnosticsTrigger)"
                  ></button>
                  @if (canHold(task)) {
                    <button
                      pButton
                      type="button"
                      size="small"
                      [attr.data-testid]="'operation-hold-' + task.id"
                      icon="pi pi-pause"
                      label="Поставить на паузу"
                      severity="secondary"
                      (click)="openTaskAction(task, 'hold')"
                    ></button>
                  }
                </div>
              </li>
            } @empty {
              <li class="muted operation-tasks__empty">Нет открытых вопросов и текущих ошибок.</li>
            }
          </ul>
        </section>

        @if (attention().history.length) {
          <details class="surface operation-history" data-testid="operation-history">
            <summary>История повторных ошибок ({{ attention().history.length }})</summary>
            <ul class="operation-tasks">
              @for (task of attention().history; track task.id) {
                <li class="operation-task">
                  <div class="operation-task__main">
                    <a [routerLink]="['/', task.id]">{{ task.title }}</a>
                    <p class="muted">{{ repoLabel(task.repositoryName) }} · {{ statusLabel(task.status) }} · {{ repeatLabel(task) }}</p>
                  </div>
                </li>
              }
            </ul>
          </details>
        }

        <section #workersSection class="surface operations-section" aria-labelledby="operations-workers-heading" tabindex="-1">
          <header class="section-header">
            <h2 id="operations-workers-heading">Пульс воркеров</h2>
            <p-tag [value]="String(workerRows().length)" severity="secondary" />
          </header>
          <div class="operations-table" role="region" aria-label="Состояние воркеров" tabindex="0">
            <p-table [value]="workerRows()">
              <ng-template #header>
                <tr>
                  <th>Воркер</th>
                  <th>Состояние</th>
                  <th>Репозиторий</th>
                  <th>Текущая задача</th>
                  <th>Этап</th>
                  <th>Возраст пульса</th>
                  <th>Последняя ошибка</th>
                </tr>
              </ng-template>
              <ng-template #body let-row>
                <tr>
                  <td>{{ row.worker.workerId }}</td>
                  <td><p-tag [value]="row.worker.state || 'неизвестно'" [severity]="workerStateSeverity(row.worker.state)" /></td>
                  <td>{{ repoLabel(row.worker.repositoryName) }}</td>
                  <td>
                    @if (row.worker.currentTaskId) {
                      <a [routerLink]="['/', row.worker.currentTaskId]">{{ row.worker.currentTaskId }}</a>
                    } @else {
                      {{ row.worker.currentIssueKey || row.worker.issueKey || 'нет' }}
                    }
                  </td>
                  <td>{{ row.worker.currentStage || row.worker.stage || 'ожидание' }}</td>
                  <td>
                    <p-tag [value]="heartbeatLabel(row.health)" [severity]="heartbeatSeverity(row.health)" />
                    <span class="muted">{{ formatDuration(row.heartbeatAgeSeconds) }}</span>
                  </td>
                  <td>{{ truncate(row.worker.lastErrorSummary, 140) || 'нет' }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="7">В этом снимке нет воркеров.</td></tr>
              </ng-template>
            </p-table>
          </div>
        </section>

        <div class="operations-grid">
          <section #leasesSection class="surface operations-section" aria-labelledby="operations-leases-heading" tabindex="-1">
            <header class="section-header">
              <h2 id="operations-leases-heading">Активные аренды</h2>
              <p-tag [value]="String(activeLeases().length)" severity="secondary" />
            </header>
            <div class="operations-table" role="region" aria-label="Таблица активных аренд" tabindex="0">
              <p-table [value]="activeLeases()">
                <ng-template #header>
                  <tr>
                    <th>Аренда</th>
                    <th>Тип</th>
                    <th>Задача</th>
                    <th>Репозиторий</th>
                    <th>Воркер</th>
                    <th>Истекает</th>
                    <th>Пульс</th>
                  </tr>
                </ng-template>
                <ng-template #body let-lease>
                  <tr>
                    <td>{{ lease.id }}</td>
                    <td>{{ lease.kind }}</td>
                    <td>
                      @if (lease.taskId) {
                        <a [routerLink]="['/', lease.taskId]">{{ lease.taskId }}</a>
                      } @else {
                        нет
                      }
                    </td>
                    <td>{{ repoLabel(lease.repositoryName) }}</td>
                    <td>{{ lease.workerId }}</td>
                    <td>{{ formatDate(lease.expiresAt) }}</td>
                    <td>{{ formatDate(lease.heartbeatAt) }}</td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage>
                  <tr><td colspan="7">Нет активных аренд.</td></tr>
                </ng-template>
              </p-table>
            </div>
          </section>

          <section class="surface operations-section" aria-labelledby="operations-queue-heading" tabindex="-1">
            <header class="section-header">
              <h2 id="operations-queue-heading">Глубина очереди</h2>
              <p-tag [value]="String(queueDepth().length)" severity="secondary" />
            </header>
            <div class="operations-table" role="region" aria-label="Таблица глубины очереди" tabindex="0">
              <p-table [value]="queueDepth()">
                <ng-template #header>
                  <tr>
                    <th>Репозиторий</th>
                    <th>Очередь</th>
                    <th>Статус</th>
                    <th>Приоритет</th>
                    <th>Глубина</th>
                  </tr>
                </ng-template>
                <ng-template #body let-row>
                  <tr>
                    <td>
                      @if (row.repositoryName !== 'unassigned') {
                        <a
                          class="operations-queue-link"
                          routerLink="/"
                          [queryParams]="queueDepthParams(row)"
                          [attr.aria-label]="'Открыть очередь проекта ' + repoLabel(row.repositoryName) + ', ' + statusLabel(row.status)"
                        >{{ repoLabel(row.repositoryName) }}</a>
                      } @else {
                        {{ repoLabel(undefined) }}
                      }
                    </td>
                    <td>{{ row.queue }}</td>
                    <td><p-tag [value]="statusLabel(row.status)" [severity]="statusSeverity(row.status)" /></td>
                    <td>{{ row.priority || 'не назначено' }}</td>
                    <td>{{ row.depth }}</td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage>
                  <tr><td colspan="5">Нет строк глубины очереди.</td></tr>
                </ng-template>
              </p-table>
            </div>
          </section>
        </div>
      } @else {
        <div class="empty-state surface">
          <i class="pi pi-server" aria-hidden="true"></i>
          <h2>Нет операционного снимка</h2>
          <p>Обновите страницу, чтобы загрузить данные операций воркеров и задач.</p>
        </div>
      }
    </section>

    <p-dialog
      header="Детали диагностики"
      closeAriaLabel="Закрыть диагностику"
      [visible]="!!selectedTask()"
      (visibleChange)="!$event && closeDiagnostics()"
      (onHide)="restoreDiagnosticsFocus()"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: 'min(720px, 94vw)' }"
    >
      @if (selectedTask(); as task) {
        <div class="operations-diagnostics" data-testid="operation-diagnostics">
          <div class="summary-block">
            <h2>{{ task.title }}</h2>
            <a class="external-link" [routerLink]="['/', task.id]">Открыть задачу <i class="pi pi-arrow-right" aria-hidden="true"></i></a>
          </div>
          @if (selectedDiagnostic(); as diagnostic) {
            <div class="detail-grid">
              <div class="summary-block">
                <h3>Сводка ошибки</h3>
                <div class="field-grid field-grid--compact">
                  <div>
                    <span class="field-label">Ошибочные запуски агента</span>
                    <span>{{ diagnostic.failedAgentRuns }}</span>
                  </div>
                  <div>
                    <span class="field-label">Повторные ошибки валидации</span>
                    <span>{{ diagnostic.repeatedValidationFailures }}</span>
                  </div>
                  <div>
                    <span class="field-label">Обновлено</span>
                    <span>{{ formatDate(diagnostic.updatedAt || task.updatedAt) }}</span>
                  </div>
                </div>
                @if (diagnostic.latestFailedAgentRun) {
                  <p class="prewrap">{{ truncate(diagnostic.latestFailedAgentRun.finalMessage || diagnostic.latestFailedAgentRun.diagnostic, 900) }}</p>
                }
              </div>

              <div class="summary-block">
                <h3>Валидация</h3>
                @if (diagnostic.latestValidation) {
                  <div class="tag-row">
                    <p-tag [value]="diagnostic.latestValidation.status" [severity]="diagnostic.latestValidation.status === 'failed' ? 'danger' : 'success'" />
                    @if (diagnostic.latestValidation.workerId) {
                      <span>{{ diagnostic.latestValidation.workerId }}</span>
                    }
                  </div>
                  <p class="prewrap">{{ truncate(diagnostic.latestValidation.summary || diagnostic.latestValidation.diagnostic, 900) }}</p>
                } @else {
                  <p class="muted">В этом снимке нет сводки валидации.</p>
                }
              </div>
            </div>

            @if (diagnostic.latestQuestion) {
              <div class="summary-block">
                <h3>Открытый вопрос</h3>
                <p>{{ diagnostic.latestQuestion.summary || diagnostic.latestQuestion.blockingReason || 'Вопрос ожидает ответа.' }}</p>
                @if (diagnostic.latestQuestion.question) {
                  <p class="prewrap">{{ truncate(diagnostic.latestQuestion.question, 900) }}</p>
                }
              </div>
            }

            <div class="summary-block">
              <h3>Последние события жизненного цикла</h3>
              @if (diagnostic.recentEvents.length) {
                <div class="timeline-list">
                  @for (event of diagnostic.recentEvents; track event.id || event.kind + event.createdAt) {
                    <div class="timeline-item">
                      <div class="timeline-item__meta">
                        <strong>{{ statusLabel(event.kind) }}</strong>
                        <span>{{ formatDate(event.createdAt) }}</span>
                      </div>
                      @if (event.message) {
                        <p>{{ truncate(event.message, 420) }}</p>
                      }
                    </div>
                  }
                </div>
              } @else {
                <p class="muted">В этом снимке нет последних событий жизненного цикла.</p>
              }
            </div>
          } @else {
            <p class="muted">В последнем снимке нет деталей диагностики для этой задачи.</p>
          }
        </div>
      }
    </p-dialog>

    <p-dialog
      [header]="pendingAction()?.label || 'Подтвердите операцию'"
      [visible]="commandDialogVisible()"
      (visibleChange)="commandDialogVisible.set($event)"
      [modal]="true"
      [style]="{ width: 'min(560px, 94vw)' }"
    >
      <div data-testid="operation-command-dialog">
      @if (pendingAction(); as action) {
        <div class="stack">
          <p>{{ action.task.title }}</p>
          @if (commandError(); as message) {
            <p-message severity="error" [text]="message" />
          }
          <label class="field">
            <span>Причина <strong aria-label="обязательно">*</strong></span>
            <textarea
              pTextarea
              data-testid="operation-reason"
              autofocus
              rows="4"
              [formControl]="reasonControl"
              placeholder="Укажите причину оператора"
            ></textarea>
          </label>
          <div class="action-bar action-bar--end">
            <button pButton type="button" data-testid="operation-cancel" label="Отмена" severity="secondary" (click)="closeCommandDialog()"></button>
            <button
              pButton
              type="button"
              data-testid="operation-confirm"
              icon="pi pi-check"
              label="Подтвердить"
              [disabled]="reasonControl.invalid || submitting()"
              (click)="submitTaskAction()"
            ></button>
          </div>
        </div>
      }
      </div>
    </p-dialog>
  `,
  styles: [`
    .operations-status, .operations-metric { min-width: 0; }
    .operations-status { flex-wrap: wrap; }
    .operations-header-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: end;
    }
    .operations-project { flex: 1 1 200px; min-width: 0; max-width: 340px; }
    .operations-project select {
      width: 100%;
      min-height: 40px;
      padding-inline: 10px;
      border: 1px solid var(--console-border);
      border-radius: 8px;
      background: var(--console-panel);
      color: var(--console-text);
    }
    .operations-overview { grid-template-columns: repeat(auto-fit, minmax(min(100%, 128px), 1fr)); }
    .operations-metric {
      text-align: left;
      text-decoration: none;
      color: var(--console-text);
      cursor: pointer;
    }
    .operations-metric:hover { border-color: var(--console-focus); }
    .operations-metric .metric__value { font-size: 1.5rem; }
    .operations-metric .attention { color: #814408; }
    .operations-metric .failure { color: #b42318; }
    .operations-section {
      overflow: visible;
      scroll-margin-block-start: 6rem;
    }
    .operations-table { max-width: 100%; overflow-x: auto; }
    .operations-table p-table { display: block; min-width: 42rem; }
    .operations-table th, .operations-table td { padding: .65rem .75rem; }
    .operations-table td { overflow-wrap: anywhere; }
    .operation-tasks { display: grid; gap: 8px; padding: 0; margin: 0; list-style: none; }
    .operation-tasks__empty { padding: 8px 0; }
    .operation-task {
      display: grid;
      gap: 10px;
      min-width: 0;
      padding: 12px;
      border: 1px solid var(--console-border);
      border-radius: 8px;
      background: var(--console-panel-muted);
    }
    .operation-task__main { min-width: 0; overflow-wrap: anywhere; }
    .operation-task__main > a, .operations-queue-link { color: var(--console-link); font-weight: 650; }
    .operation-task__main > .tag-row { margin-bottom: 6px; }
    .operation-task__main p { margin: 4px 0 0; }
    .operation-repeat { font-weight: 600; color: var(--console-muted); }
    .operation-history summary { cursor: pointer; color: var(--console-link); font-weight: 650; }
    .operation-history .operation-tasks { margin-top: 10px; }

    @media (min-width: 820px) {
      .operation-task { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
    }
    .operations-diagnostics { display: grid; gap: 16px; overflow-wrap: anywhere; }
    .operations-diagnostics h2 { margin: 0; font-size: 1.2rem; }

    @media (max-width: 520px) {
      .operations-overview { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
      .operations-metric { min-height: 54px; gap: 2px; padding: 4px 7px; }
      .operations-metric .metric__label { font-size: .75rem; line-height: 1.15; }
      .operations-metric .metric__value { font-size: 1.125rem; line-height: 1.1; }
    }
  `],
})
export class OperationsPageComponent implements OnInit {
  private readonly operations = inject(OperationsService);
  private readonly commands = inject(TaskCommandService);
  private readonly session = inject(SessionService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly repositoryDirectory = inject(RepositoryDirectoryService);

  protected readonly repository = signal('');
  protected readonly snapshot = signal<OperationsSnapshotDto | undefined>(undefined);
  protected readonly selectedTask = signal<TaskSummaryDto | undefined>(undefined);
  protected readonly pendingAction = signal<PendingOperationAction | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly refreshing = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly refreshError = signal<string | undefined>(undefined);
  protected readonly commandError = signal<string | undefined>(undefined);
  protected readonly lastRefreshAttempt = signal<string | undefined>(undefined);
  protected readonly commandDialogVisible = signal(false);
  protected readonly reasonControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required],
  });

  protected readonly overview = computed<OperationsOverview>(() => {
    const snapshot = this.snapshot();
    return {
      activeWorkers: snapshot?.workers.filter((worker) => worker.state !== 'shutting_down').length ?? 0,
      readyDepth:
        snapshot?.queueDepth
          .filter((row) => row.status === 'ready')
          .reduce((total, row) => total + row.depth, 0) ?? 0,
      failedTasks: snapshot?.failedTasks.length ?? 0,
      waitingForHuman: snapshot?.waitingForHuman.length ?? 0,
      activeLeases: snapshot?.leases.filter((lease) => !lease.releasedAt).length ?? 0,
    };
  });

  protected readonly workerRows = computed<WorkerRow[]>(() => {
    const snapshot = this.snapshot();
    return (snapshot?.workers ?? []).map((worker) => ({
      worker,
      heartbeatAgeSeconds: heartbeatAgeSeconds(worker, snapshot?.generatedAt),
      health: classifyHeartbeat(worker, snapshot?.generatedAt),
    }));
  });

  protected readonly activeLeases = computed(() =>
    (this.snapshot()?.leases ?? []).filter((lease) => !lease.releasedAt),
  );
  protected readonly queueDepth = computed(() =>
    [...(this.snapshot()?.queueDepth ?? [])].sort((left, right) =>
      `${left.repositoryName}:${left.queue}:${left.status}:${left.priority ?? ''}`.localeCompare(
        `${right.repositoryName}:${right.queue}:${right.status}:${right.priority ?? ''}`,
      ),
    ),
  );
  protected readonly repositories = computed(() => {
    const options = new Set([
      ...this.repositoryDirectory.options().map(({ id }) => id),
      ...(this.snapshot()?.repositories ?? []),
      ...this.queueDepth().map(({ repositoryName }) => repositoryName),
    ]);
    options.delete('unassigned');
    const selected = this.repository();
    if (selected) {
      options.add(selected);
    }
    return [...options].sort((left, right) => this.repoLabel(left).localeCompare(this.repoLabel(right), 'ru'));
  });
  protected readonly diagnosticsByTaskId = computed(
    () => new Map((this.snapshot()?.taskDiagnostics ?? []).map((entry) => [entry.taskId, entry])),
  );
  protected readonly attention = computed(() =>
    buildOperationsAttention(this.snapshot(), this.diagnosticsByTaskId()),
  );
  protected readonly selectedDiagnostic = computed(() => {
    const task = this.selectedTask();
    return task ? this.diagnosticsByTaskId().get(task.id) : undefined;
  });

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private diagnosticsTrigger: HTMLElement | undefined;
  private snapshotRequest: Subscription | undefined;

  ngOnInit(): void {
    this.route.queryParamMap.pipe(
      map((params) => params.get('repository')?.trim() ?? ''),
      distinctUntilChanged(),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((repository) => {
      this.snapshotRequest?.unsubscribe();
      this.repository.set(repository);
      this.snapshot.set(undefined);
      this.loading.set(false);
      this.refreshing.set(false);
      this.refreshError.set(undefined);
      this.closeDiagnostics();
      this.closeCommandDialog();
      this.load(true);
    });
    this.pollTimer = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        this.load(false);
      }
    }, POLL_INTERVAL_MS);
    this.destroyRef.onDestroy(() => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
    });
  }

  protected selectRepository(repository: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { repository: repository || null },
      queryParamsHandling: 'merge',
    });
  }

  protected repoLabel(repository: string | undefined): string {
    return this.repositoryDirectory.repoLabel(repository) || 'Проект не назначен';
  }

  protected queueParams(status: string, repository = this.repository()): Record<string, string> {
    return { status, ...(repository ? { repository } : {}) };
  }

  protected queueDepthParams(row: QueueDepthDto): Record<string, string> {
    return {
      ...this.queueParams(row.status, row.repositoryName),
      ...(row.queue !== 'unassigned' ? { queue: row.queue } : {}),
      ...(row.priority && row.priority !== 'unassigned' ? { priority: row.priority } : {}),
    };
  }

  protected focusSection(section: HTMLElement): void {
    section.scrollIntoView({ block: 'start' });
    section.focus({ preventScroll: true });
  }

  protected refreshNow(): void {
    this.load(false);
  }

  protected openDiagnostics(task: TaskSummaryDto, trigger?: HTMLElement): void {
    this.diagnosticsTrigger = trigger;
    this.selectedTask.set(task);
  }

  protected closeDiagnostics(): void {
    this.selectedTask.set(undefined);
  }

  protected restoreDiagnosticsFocus(): void {
    const trigger = this.diagnosticsTrigger;
    this.diagnosticsTrigger = undefined;
    if (trigger?.isConnected) {
      trigger.focus({ preventScroll: true });
    }
  }

  protected canRetry(task: TaskSummaryDto): boolean {
    return canUseCapability(this.session.session(), 'canRetry') && ['failed', 'blocked'].includes(task.status);
  }

  protected canHold(task: TaskSummaryDto): boolean {
    return canUseCapability(this.session.session(), 'canHold') && HOLDABLE_STATUSES.has(task.status);
  }

  protected canAnswer(): boolean {
    return canUseCapability(this.session.session(), 'canAnswer');
  }

  protected openTaskAction(
    task: TaskSummaryDto,
    command: Extract<TaskCommandName, 'retry' | 'hold'>,
  ): void {
    this.pendingAction.set({
      task,
      command,
      label: command === 'retry' ? 'Повторить задачу' : 'Поставить задачу на паузу',
    });
    this.commandError.set(undefined);
    this.reasonControl.reset('');
    this.commandDialogVisible.set(true);
    setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('[data-testid="operation-reason"]')?.focus();
    });
  }

  protected submitTaskAction(): void {
    const action = this.pendingAction();
    if (!action || this.reasonControl.invalid) {
      this.reasonControl.markAsTouched();
      return;
    }
    this.submitting.set(true);
    this.commandError.set(undefined);
    this.commands
      .run(action.task.id, action.command, { reason: this.reasonControl.value.trim() })
      .subscribe({
        next: () => {
          this.closeCommandDialog();
          this.submitting.set(false);
          this.load(false);
        },
        error: (error: unknown) => {
          this.commandError.set(error instanceof Error ? error.message : String(error));
          this.submitting.set(false);
        },
      });
  }

  protected closeCommandDialog(): void {
    this.commandDialogVisible.set(false);
    this.pendingAction.set(undefined);
    this.reasonControl.reset('');
  }

  protected diagnosticFor(task: TaskSummaryDto): OperationTaskDiagnosticDto | undefined {
    return this.diagnosticsByTaskId().get(task.id);
  }

  protected diagnosticSummary(task: TaskSummaryDto): string {
    const diagnostic = this.diagnosticFor(task);
    return (
      truncate(
        diagnostic?.latestValidation?.summary ||
          diagnostic?.latestValidation?.diagnostic ||
          diagnostic?.latestFailedAgentRun?.finalMessage ||
          diagnostic?.latestFailedAgentRun?.diagnostic ||
          task.latestValidationSummary ||
          task.latestAiSummary,
        180,
      ) || 'Нет сводки диагностики'
    );
  }

  protected waitingSummary(task: TaskSummaryDto): string {
    const diagnostic = this.diagnosticFor(task);
    return (
      truncate(
        diagnostic?.latestQuestion?.summary ||
          diagnostic?.latestQuestion?.blockingReason ||
          diagnostic?.latestQuestion?.question ||
          task.blockerReason,
        220,
      ) || 'Ожидается ответ человека'
    );
  }

  protected repeatLabel(task: TaskSummaryDto): string {
    const diagnostic = this.diagnosticFor(task);
    if (!diagnostic) {
      return 'Есть повторные ошибки';
    }
    const count = Math.max(0, diagnostic.failedAgentRuns - 1) +
      Math.max(0, diagnostic.repeatedValidationFailures - 1);
    return count > 0 ? `Повторных ошибок: ${count}` : 'Есть повторные ошибки';
  }

  protected waitingTimeLabel(row: OperationsAttentionRow): string {
    if (row.waitingSince === undefined) {
      return 'Длительность ожидания неизвестна';
    }
    const reference = parseTime(this.snapshot()?.generatedAt) ?? Date.now();
    const duration = formatDuration(Math.max(0, Math.floor((reference - row.waitingSince) / 1000)));
    return row.waitingAgeIsApproximate ? `Примерно ${duration} ожидания` : `Ждёт ${duration}`;
  }

  protected heartbeatLabel(health: HeartbeatHealth): string {
    if (health === 'healthy') {
      return 'В норме';
    }
    if (health === 'warning') {
      return 'Устаревает';
    }
    if (health === 'error') {
      return 'Устарел';
    }
    return 'Неизвестно';
  }

  protected heartbeatSeverity(
    health: HeartbeatHealth,
  ): 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' {
    if (health === 'healthy') {
      return 'success';
    }
    if (health === 'warning') {
      return 'warn';
    }
    if (health === 'error') {
      return 'danger';
    }
    return 'secondary';
  }

  protected workerStateSeverity(
    state: string,
  ): 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' {
    if (state === 'processing') {
      return 'info';
    }
    if (state === 'idle' || state === 'polling') {
      return 'success';
    }
    if (state === 'waiting') {
      return 'warn';
    }
    if (state === 'error') {
      return 'danger';
    }
    return 'secondary';
  }

  protected statusLabel(status: string): string {
    return statusLabel(status);
  }

  protected statusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' {
    return statusSeverity(status);
  }

  protected formatDate(value: string | undefined): string {
    return formatDate(value);
  }

  protected truncate(value: string | undefined, max?: number): string {
    return truncate(value, max);
  }

  protected formatDuration(value: number | undefined): string {
    return formatDuration(value);
  }

  protected readonly String = String;

  private load(initial: boolean): void {
    if (this.loading() || this.refreshing()) {
      return;
    }
    this.lastRefreshAttempt.set(new Date().toISOString());
    if (initial && !this.snapshot()) {
      this.loading.set(true);
    } else {
      this.refreshing.set(true);
    }
    this.error.set(undefined);
    this.snapshotRequest = this.operations.snapshot(this.repository()).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (snapshot) => {
        this.snapshot.set(snapshot);
        this.refreshError.set(undefined);
        this.loading.set(false);
        this.refreshing.set(false);
      },
      error: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (this.snapshot()) {
          this.refreshError.set(message);
        } else {
          this.error.set(message);
        }
        this.loading.set(false);
        this.refreshing.set(false);
      },
    });
  }
}
