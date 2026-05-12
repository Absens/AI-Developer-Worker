import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';

import {
  OperationTaskDiagnosticDto,
  OperationsSnapshotDto,
  TaskSummaryDto,
  WorkerSnapshotDto,
} from '../models/human-api.dto';
import { OperationsService } from '../services/operations.service';
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
  repeatedFailures: number;
  repositories: number;
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
          <p>Воркеры, аренды, нагрузка очередей, ошибки и ожидание человека из операционного снимка.</p>
        </div>
        <div class="action-bar action-bar--end">
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
        <div class="surface operations-status">
          <span>Сформировано {{ formatDate(current.generatedAt) }}</span>
          @if (lastRefreshAttempt(); as attempt) {
            <span>Последняя проверка {{ formatDate(attempt) }}</span>
          }
          @if (refreshError(); as message) {
            <p-tag value="Устаревший снимок" severity="warn" />
            <span class="error-text">Ошибка обновления: {{ message }}</span>
          }
        </div>
      }

      @if (error(); as message) {
        <p-message severity="error" [text]="message" />
      }

      @if (refreshError() && snapshot()) {
        <p-message
          severity="warn"
          text="Показан последний успешный снимок, потому что последнее обновление завершилось ошибкой."
        />
      }

      @if (loading() && !snapshot()) {
        <div class="loading-row" aria-live="polite">
          <p-progressSpinner ariaLabel="Загрузка операций" />
          <span>Загрузка операций</span>
        </div>
      } @else if (snapshot(); as current) {
        <div class="metric-strip operations-overview">
          <div class="metric">
            <span class="metric__label">Активные воркеры</span>
            <span class="metric__value">{{ overview().activeWorkers }}</span>
          </div>
          <div class="metric">
            <span class="metric__label">Готовая очередь</span>
            <span class="metric__value">{{ overview().readyDepth }}</span>
          </div>
          <div class="metric">
            <span class="metric__label">Задачи с ошибкой</span>
            <span class="metric__value">{{ overview().failedTasks }}</span>
          </div>
          <div class="metric">
            <span class="metric__label">Ждет человека</span>
            <span class="metric__value">{{ overview().waitingForHuman }}</span>
          </div>
          <div class="metric">
            <span class="metric__label">Активные аренды</span>
            <span class="metric__value">{{ overview().activeLeases }}</span>
          </div>
          <div class="metric">
            <span class="metric__label">Повторные ошибки</span>
            <span class="metric__value">{{ overview().repeatedFailures }}</span>
          </div>
        </div>

        <section class="surface operations-section">
          <header class="section-header">
            <h2>Пульс воркеров</h2>
            <p-tag [value]="String(workerRows().length)" severity="secondary" />
          </header>
          <p-table [value]="workerRows()" styleClass="ops-table">
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
                <td>{{ row.worker.repositoryName || 'не назначено' }}</td>
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
        </section>

        <div class="operations-grid">
          <section class="surface operations-section">
            <header class="section-header">
              <h2>Активные аренды</h2>
              <p-tag [value]="String(activeLeases().length)" severity="secondary" />
            </header>
            <p-table [value]="activeLeases()" styleClass="ops-table">
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
                  <td>{{ lease.repositoryName || 'не назначено' }}</td>
                  <td>{{ lease.workerId }}</td>
                  <td>{{ formatDate(lease.expiresAt) }}</td>
                  <td>{{ formatDate(lease.heartbeatAt) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="7">Нет активных аренд.</td></tr>
              </ng-template>
            </p-table>
          </section>

          <section class="surface operations-section">
            <header class="section-header">
              <h2>Глубина очереди</h2>
              <p-tag [value]="String(queueDepth().length)" severity="secondary" />
            </header>
            <p-table [value]="queueDepth()" styleClass="ops-table">
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
                  <td>{{ row.repositoryName }}</td>
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
          </section>
        </div>

        <div class="operations-grid">
          <section class="surface operations-section">
            <header class="section-header">
              <h2>Задачи с ошибкой</h2>
              <p-tag [value]="String(failedTasks().length)" severity="danger" />
            </header>
            <p-table [value]="failedTasks()" styleClass="ops-table">
              <ng-template #header>
                <tr>
                  <th>Задача</th>
                  <th>Репозиторий</th>
                  <th>Последняя сводка</th>
                  <th>Обновлено</th>
                  <th>Действия</th>
                </tr>
              </ng-template>
              <ng-template #body let-task>
                <tr>
                  <td><a [routerLink]="['/', task.id]">{{ task.title }}</a></td>
                  <td>{{ task.repositoryName || 'не назначено' }}</td>
                  <td>{{ diagnosticSummary(task) }}</td>
                  <td>{{ formatDate(task.updatedAt) }}</td>
                  <td>
                    <div class="row-actions">
                      <button
                        pButton
                        type="button"
                        [attr.data-testid]="'operation-details-' + task.id"
                        icon="pi pi-info-circle"
                        label="Детали"
                        severity="secondary"
                        (click)="openDiagnostics(task)"
                      ></button>
                      @if (canRetry(task)) {
                        <button
                          pButton
                          type="button"
                          [attr.data-testid]="'operation-retry-' + task.id"
                          icon="pi pi-refresh"
                          label="Повторить"
                          (click)="openTaskAction(task, 'retry')"
                        ></button>
                      }
                      @if (canHold(task)) {
                        <button
                          pButton
                          type="button"
                          [attr.data-testid]="'operation-hold-' + task.id"
                          icon="pi pi-pause"
                          label="Поставить на паузу"
                          severity="secondary"
                          (click)="openTaskAction(task, 'hold')"
                        ></button>
                      }
                    </div>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="5">Нет задач с ошибкой.</td></tr>
              </ng-template>
            </p-table>
          </section>

          <section class="surface operations-section">
            <header class="section-header">
              <h2>Повторные ошибки</h2>
              <p-tag [value]="String(repeatedFailures().length)" severity="warn" />
            </header>
            <p-table [value]="repeatedFailures()" styleClass="ops-table">
              <ng-template #header>
                <tr>
                  <th>Задача</th>
                  <th>Репозиторий</th>
                  <th>Счетчик ошибок</th>
                  <th>Последняя сводка</th>
                  <th>Действия</th>
                </tr>
              </ng-template>
              <ng-template #body let-task>
                <tr>
                  <td><a [routerLink]="['/', task.id]">{{ task.title }}</a></td>
                  <td>{{ task.repositoryName || 'не назначено' }}</td>
                  <td>{{ failureCount(task) }}</td>
                  <td>{{ diagnosticSummary(task) }}</td>
                  <td>
                    <div class="row-actions">
                      <button
                        pButton
                        type="button"
                        [attr.data-testid]="'operation-details-' + task.id"
                        icon="pi pi-info-circle"
                        label="Детали"
                        severity="secondary"
                        (click)="openDiagnostics(task)"
                      ></button>
                      @if (canRetry(task)) {
                        <button
                          pButton
                          type="button"
                          [attr.data-testid]="'operation-retry-' + task.id"
                          icon="pi pi-refresh"
                          label="Повторить"
                          (click)="openTaskAction(task, 'retry')"
                        ></button>
                      }
                      @if (canHold(task)) {
                        <button
                          pButton
                          type="button"
                          [attr.data-testid]="'operation-hold-' + task.id"
                          icon="pi pi-pause"
                          label="Поставить на паузу"
                          severity="secondary"
                          (click)="openTaskAction(task, 'hold')"
                        ></button>
                      }
                    </div>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="5">Нет повторных ошибок.</td></tr>
              </ng-template>
            </p-table>
          </section>
        </div>

        <section class="surface operations-section">
          <header class="section-header">
            <h2>Ждет человека</h2>
            <p-tag [value]="String(waitingForHuman().length)" severity="warn" />
          </header>
          <p-table [value]="waitingForHuman()" styleClass="ops-table">
            <ng-template #header>
              <tr>
                <th>Задача</th>
                <th>Репозиторий</th>
                <th>Вопрос или блокер</th>
                <th>Время ожидания</th>
                <th>Воркер</th>
                <th>Действия</th>
              </tr>
            </ng-template>
            <ng-template #body let-task>
              <tr>
                <td><a [routerLink]="['/', task.id]">{{ task.title }}</a></td>
                <td>{{ task.repositoryName || 'не назначено' }}</td>
                <td>{{ waitingSummary(task) }}</td>
                <td>Примерно {{ approximateAge(task.updatedAt) }}</td>
                <td>{{ task.activeWorker || 'нет' }}</td>
                <td>
                  <div class="row-actions">
                    <a
                      pButton
                      [routerLink]="['/', task.id]"
                      [attr.data-testid]="'operation-open-waiting-' + task.id"
                      [icon]="canAnswer() ? 'pi pi-reply' : 'pi pi-eye'"
                      [label]="canAnswer() ? 'Ответить' : 'Открыть'"
                    ></a>
                    <button
                      pButton
                      type="button"
                      [attr.data-testid]="'operation-details-' + task.id"
                      icon="pi pi-info-circle"
                      label="Детали"
                      severity="secondary"
                      (click)="openDiagnostics(task)"
                    ></button>
                    @if (canHold(task)) {
                      <button
                        pButton
                        type="button"
                        [attr.data-testid]="'operation-hold-' + task.id"
                        icon="pi pi-pause"
                        label="Поставить на паузу"
                        severity="secondary"
                        (click)="openTaskAction(task, 'hold')"
                      ></button>
                    }
                  </div>
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="6">Нет задач, ожидающих ответа человека.</td></tr>
            </ng-template>
          </p-table>
        </section>

        @if (selectedTask(); as task) {
          <section class="surface operations-detail" aria-live="polite">
            <header class="detail-header">
              <div class="detail-header__title">
                <span class="eyebrow">Детали диагностики</span>
                <h2><a [routerLink]="['/', task.id]">{{ task.title }}</a></h2>
              </div>
              <button
                pButton
                type="button"
                icon="pi pi-times"
                label="Закрыть"
                severity="secondary"
                (click)="closeDiagnostics()"
              ></button>
            </header>

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
          </section>
        }
      } @else {
        <div class="empty-state surface">
          <i class="pi pi-server" aria-hidden="true"></i>
          <h2>Нет операционного снимка</h2>
          <p>Обновите страницу, чтобы загрузить данные операций воркеров и задач.</p>
        </div>
      }
    </section>

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
})
export class OperationsPageComponent implements OnInit {
  private readonly operations = inject(OperationsService);
  private readonly commands = inject(TaskCommandService);
  private readonly session = inject(SessionService);
  private readonly destroyRef = inject(DestroyRef);

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
      repeatedFailures: snapshot?.repeatedFailures.length ?? 0,
      repositories: snapshot?.repositories.length ?? 0,
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
  protected readonly failedTasks = computed(() => this.snapshot()?.failedTasks ?? []);
  protected readonly repeatedFailures = computed(() => this.snapshot()?.repeatedFailures ?? []);
  protected readonly waitingForHuman = computed(() => this.snapshot()?.waitingForHuman ?? []);
  protected readonly diagnosticsByTaskId = computed(
    () => new Map((this.snapshot()?.taskDiagnostics ?? []).map((entry) => [entry.taskId, entry])),
  );
  protected readonly selectedDiagnostic = computed(() => {
    const task = this.selectedTask();
    return task ? this.diagnosticsByTaskId().get(task.id) : undefined;
  });

  private pollTimer: ReturnType<typeof setInterval> | undefined;

  ngOnInit(): void {
    this.load(true);
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

  protected refreshNow(): void {
    this.load(false);
  }

  protected openDiagnostics(task: TaskSummaryDto): void {
    this.selectedTask.set(task);
  }

  protected closeDiagnostics(): void {
    this.selectedTask.set(undefined);
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

  protected failureCount(task: TaskSummaryDto): string {
    const diagnostic = this.diagnosticFor(task);
    if (!diagnostic) {
      return 'Неизвестно';
    }
    return `${diagnostic.failedAgentRuns} agent / ${diagnostic.repeatedValidationFailures} validation`;
  }

  protected approximateAge(start: string): string {
    const generatedAt = this.snapshot()?.generatedAt;
    const startMs = parseTime(start);
    const endMs = parseTime(generatedAt) ?? Date.now();
    if (startMs === undefined) {
      return 'Неизвестно';
    }
    return formatDuration(Math.max(0, Math.floor((endMs - startMs) / 1000)));
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
    this.operations.snapshot().subscribe({
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
