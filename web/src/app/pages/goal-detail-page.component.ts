import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { Observable } from 'rxjs';

import {
  ProjectGoalAuditEventDto,
  ProjectGoalCommandResponseDto,
  ProjectGoalDetailResponseDto,
  ProjectGoalDto,
  ProjectGoalProposeTasksResponseDto,
} from '../models/human-api.dto';
import { ProjectGoalService } from '../services/project-goal.service';
import { SessionService } from '../services/session.service';
import {
  canUseCapability,
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

type ReasonAction = 'reject' | 'stale';

@Component({
  selector: 'app-goal-detail-page',
  imports: [
    ButtonModule,
    CommonModule,
    DialogModule,
    MessageModule,
    ProgressSpinnerModule,
    ReactiveFormsModule,
    RouterLink,
    TagModule,
    TextareaModule,
  ],
  template: `
    <section class="page goal-detail-page" data-testid="goal-detail-page">
      <header class="page__header">
        <div>
          <a routerLink="/goals" class="muted-link">← Цели проекта</a>
          <h1>{{ detail()?.goal?.title || 'Цель проекта' }}</h1>
          @if (goal(); as currentGoal) {
            <div class="tag-row">
              <p-tag [value]="goalStatusLabel(currentGoal.status)" [severity]="goalStatusSeverity(currentGoal.status)" />
              <p-tag [value]="'Приоритет: ' + priorityLabel(currentGoal.priority)" [severity]="prioritySeverity(currentGoal.priority)" />
              <p-tag [value]="'Риск: ' + riskLabel(currentGoal.riskLevel)" [severity]="riskSeverity(currentGoal.riskLevel)" />
              <p-tag [value]="currentGoal.repositoryName" severity="secondary" />
            </div>
          }
        </div>

        @if (goal(); as currentGoal) {
          <div class="action-bar action-bar--end">
            @if (canApprove(currentGoal)) {
              <button
                pButton
                type="button"
                data-testid="goal-approve"
                icon="pi pi-check"
                label="Одобрить"
                [disabled]="submitting()"
                (click)="approve()"
              ></button>
              <button
                pButton
                type="button"
                data-testid="goal-reject"
                icon="pi pi-times"
                label="Отклонить"
                severity="danger"
                [disabled]="submitting()"
                (click)="openReasonDialog('reject')"
              ></button>
            }
            @if (canProposeTasks(currentGoal)) {
              <button
                pButton
                type="button"
                data-testid="goal-propose-tasks"
                icon="pi pi-verified"
                label="Предложить задачи"
                [disabled]="submitting()"
                (click)="proposeTasks()"
              ></button>
            }
            @if (canComplete(currentGoal)) {
              <button
                pButton
                type="button"
                data-testid="goal-complete"
                icon="pi pi-flag-fill"
                label="Завершить"
                [disabled]="submitting()"
                (click)="complete()"
              ></button>
            }
            @if (canMarkStale(currentGoal)) {
              <button
                pButton
                type="button"
                data-testid="goal-stale"
                icon="pi pi-clock"
                label="Устарело"
                severity="secondary"
                [disabled]="submitting()"
                (click)="openReasonDialog('stale')"
              ></button>
            }
            @if (canRunProjectManager()) {
              <button
                pButton
                type="button"
                data-testid="goal-run-analysis"
                icon="pi pi-sitemap"
                label="Запустить анализ"
                severity="secondary"
                [disabled]="submitting()"
                (click)="runAnalysis()"
              ></button>
              <button
                pButton
                type="button"
                data-testid="goal-run-replan"
                icon="pi pi-refresh"
                label="Перепланировать"
                severity="secondary"
                [disabled]="submitting()"
                (click)="openReplanDialog()"
              ></button>
            }
          </div>
        }
      </header>

      @if (notice(); as message) {
        <p-message severity="success" [text]="message" />
      }

      @if (error(); as message) {
        <p-message severity="error" [text]="message" />
      }

      @if (loading()) {
        <div class="loading-row" aria-live="polite">
          <p-progressSpinner ariaLabel="Загрузка цели" />
          <span>Загрузка цели</span>
        </div>
      } @else if (detail(); as currentDetail) {
        <div class="detail-grid">
          <article class="surface workflow-detail">
            <section class="detail-section goal-lifecycle">
              <h2>Состояние цели</h2>
              <div class="tag-row">
                <p-tag [value]="goalStatusLabel(currentDetail.goal.status)" [severity]="goalStatusSeverity(currentDetail.goal.status)" />
                <p-tag [value]="'Приоритет: ' + priorityLabel(currentDetail.goal.priority)" [severity]="prioritySeverity(currentDetail.goal.priority)" />
                <p-tag [value]="'Риск: ' + riskLabel(currentDetail.goal.riskLevel)" [severity]="riskSeverity(currentDetail.goal.riskLevel)" />
              </div>
              <div class="summary-block">
                <h3>Следующий шаг</h3>
                <p>{{ nextStepText(currentDetail.goal) }}</p>
              </div>
              @if (currentDetail.goal.rejectionReason) {
                <div class="summary-block">
                  <h3>Причина отклонения</h3>
                  <p>{{ currentDetail.goal.rejectionReason }}</p>
                </div>
              }
              @if (currentDetail.goal.staleReason) {
                <div class="summary-block">
                  <h3>Причина устаревания</h3>
                  <p>{{ currentDetail.goal.staleReason }}</p>
                </div>
              }
            </section>

            <section class="detail-section">
              <h2>Метаданные</h2>
              <div class="field-grid">
                <div>
                  <span class="field-label">ID цели</span>
                  <span>{{ currentDetail.goal.id }}</span>
                </div>
                <div>
                  <span class="field-label">Source analysis id</span>
                  <span>{{ currentDetail.goal.sourceAnalysisId }}</span>
                </div>
                <div>
                  <span class="field-label">Source run id</span>
                  <span>{{ currentDetail.goal.sourceRunId || 'Не указан' }}</span>
                </div>
                <div>
                  <span class="field-label">Создано</span>
                  <span>{{ formatDate(currentDetail.goal.createdAt) }}</span>
                </div>
                <div>
                  <span class="field-label">Обновлено</span>
                  <span>{{ formatDate(currentDetail.goal.updatedAt) }}</span>
                </div>
              </div>
            </section>

            <section class="detail-section">
              <h2>Проблема</h2>
              <p>{{ currentDetail.goal.problemStatement }}</p>
            </section>

            <section class="detail-section">
              <h2>Желаемый результат</h2>
              <p>{{ currentDetail.goal.desiredOutcome }}</p>
            </section>

            <section class="detail-section">
              <h2>Метрики успеха</h2>
              @if (currentDetail.goal.successMetrics.length) {
                <ul class="compact-list">
                  @for (metric of currentDetail.goal.successMetrics; track metric) {
                    <li>{{ metric }}</li>
                  }
                </ul>
              } @else {
                <p>Метрики не указаны.</p>
              }
            </section>

            <section class="detail-section">
              <h2>Доказательства</h2>
              @if (currentDetail.goal.evidenceRefs.length) {
                <div class="evidence-list">
                  @for (evidence of currentDetail.goal.evidenceRefs; track evidence.kind + evidence.ref) {
                    <div class="evidence-item">
                      <strong>{{ evidence.kind }}</strong>
                      <span>{{ evidence.ref }}</span>
                      @if (evidence.summary) {
                        <p>{{ truncate(evidence.summary, 260) }}</p>
                      }
                    </div>
                  }
                </div>
              } @else {
                <p>Доказательства не указаны.</p>
              }
            </section>

            <section class="detail-section">
              <h2>Черновики задач</h2>
              @if (currentDetail.goal.suggestedTaskProposals.length) {
                <div class="draft-list">
                  @for (draft of currentDetail.goal.suggestedTaskProposals; track draft.title) {
                    <article class="summary-block">
                      <h3>{{ draft.title }}</h3>
                      <p>{{ draft.description }}</p>
                      <div class="tag-row">
                        <p-tag [value]="draft.taskType" severity="secondary" />
                        @if (draft.expectedBlastRadius) {
                          <p-tag [value]="draft.expectedBlastRadius" severity="secondary" />
                        }
                      </div>
                      @if (draft.acceptanceCriteria.length) {
                        <ul class="compact-list">
                          @for (criterion of draft.acceptanceCriteria; track criterion) {
                            <li>{{ criterion }}</li>
                          }
                        </ul>
                      }
                    </article>
                  }
                </div>
              } @else {
                <p>Черновики задач не предложены.</p>
              }
            </section>
          </article>

          <aside class="surface workflow-detail">
            <section class="detail-section">
              <h2>Связанные задачи</h2>
              @if (currentDetail.linkedTasks.length) {
                <div class="linked-list">
                  @for (task of currentDetail.linkedTasks; track task.id) {
                    <a [routerLink]="['/', task.id]" class="linked-row">
                      <span>{{ task.title }}</span>
                      <p-tag [value]="statusLabel(task.status)" [severity]="taskStatusSeverity(task.status)" />
                    </a>
                  }
                </div>
              } @else if (currentDetail.taskLinks.length) {
                <div class="linked-list">
                  @for (link of currentDetail.taskLinks; track link.id) {
                    <a [routerLink]="['/', link.taskId]" class="linked-row">
                      <span>{{ link.taskId }}</span>
                      <p-tag [value]="link.linkType" severity="secondary" />
                    </a>
                  }
                </div>
              } @else {
                <p>Связанные задачи отсутствуют.</p>
              }
            </section>

            <section class="detail-section">
              <h2>Аудит цели</h2>
              @if (currentDetail.auditEvents.length) {
                <ol class="timeline-list">
                  @for (event of currentDetail.auditEvents; track event.id) {
                    <li>
                      <strong>{{ auditEventLabel(event.kind) }}</strong>
                      @if (event.message) {
                        <p>{{ event.message }}</p>
                      }
                      @if (isReplanClassified(event)) {
                        <p>Decision: {{ auditPayloadValue(event, 'decision') }}</p>
                        <p>Rationale: {{ auditPayloadValue(event, 'rationale') }}</p>
                      }
                      <span class="field-label">
                        {{ formatDate(event.createdAt) }}
                        @if (event.actor) {
                          · {{ event.actor.displayName || event.actor.id }}
                        }
                      </span>
                    </li>
                  }
                </ol>
              } @else {
                <p>Аудит пуст.</p>
              }
            </section>
          </aside>
        </div>
      }
    </section>

    <p-dialog
      [header]="reasonDialogTitle()"
      [visible]="reasonDialogVisible()"
      (visibleChange)="reasonDialogVisible.set($event)"
      [modal]="true"
      [style]="{ width: 'min(560px, 94vw)' }"
    >
      <div class="stack" data-testid="goal-reason-dialog">
        <label class="field">
          <span>Причина <strong aria-label="обязательно">*</strong></span>
          <textarea
            pTextarea
            data-testid="goal-reason"
            rows="4"
            [formControl]="reasonControl"
            placeholder="Укажите причину"
          ></textarea>
        </label>
        <div class="action-bar action-bar--end">
          <button
            pButton
            type="button"
            data-testid="goal-reason-cancel"
            label="Отмена"
            severity="secondary"
            (click)="closeReasonDialog()"
          ></button>
          <button
            pButton
            type="button"
            data-testid="goal-reason-confirm"
            icon="pi pi-check"
            label="Подтвердить"
            [disabled]="submitting() || reasonControl.invalid"
            (click)="submitReasonAction()"
          ></button>
        </div>
      </div>
    </p-dialog>

    <p-dialog
      header="Перепланировать цель"
      [visible]="replanDialogVisible()"
      (visibleChange)="replanDialogVisible.set($event)"
      [modal]="true"
      [style]="{ width: 'min(560px, 94vw)' }"
    >
      <div class="stack" data-testid="goal-replan-dialog">
        <label class="field">
          <span>Причина <strong aria-label="обязательно">*</strong></span>
          <textarea
            pTextarea
            data-testid="goal-replan-reason"
            rows="4"
            [formControl]="replanReasonControl"
            placeholder="Укажите причину перепланирования"
          ></textarea>
        </label>
        <div class="action-bar action-bar--end">
          <button
            pButton
            type="button"
            data-testid="goal-replan-cancel"
            label="Отмена"
            severity="secondary"
            (click)="closeReplanDialog()"
          ></button>
          <button
            pButton
            type="button"
            data-testid="goal-replan-confirm"
            icon="pi pi-check"
            label="Подтвердить"
            [disabled]="submitting()"
            (click)="submitReplan()"
          ></button>
        </div>
      </div>
    </p-dialog>
  `,
})
export class GoalDetailPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly goalsApi = inject(ProjectGoalService);
  private readonly session = inject(SessionService);
  private readonly messages = inject(MessageService);

  protected readonly reasonControl = new FormControl<string>('', {
    nonNullable: true,
    validators: [Validators.required],
  });
  protected readonly replanReasonControl = new FormControl<string>('', {
    nonNullable: true,
    validators: [Validators.required],
  });
  protected readonly detail = signal<ProjectGoalDetailResponseDto | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly notice = signal<string | undefined>(undefined);
  protected readonly reasonDialogVisible = signal(false);
  protected readonly replanDialogVisible = signal(false);
  protected readonly pendingReasonAction = signal<ReasonAction | undefined>(undefined);

  private readonly goalId = this.route.snapshot.paramMap.get('goalId') ?? '';

  ngOnInit(): void {
    this.load();
  }

  protected goal(): ProjectGoalDto | undefined {
    return this.detail()?.goal;
  }

  protected load(): void {
    if (!this.goalId) {
      this.error.set('ID цели не указан.');
      return;
    }
    this.loading.set(true);
    this.error.set(undefined);
    this.goalsApi.get(this.goalId).subscribe({
      next: (detail) => {
        this.detail.set(detail);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.error.set(error instanceof Error ? error.message : String(error));
        this.loading.set(false);
      },
    });
  }

  protected approve(): void {
    this.runCommand('Цель одобрена.', this.goalsApi.approve(this.goalId));
  }

  protected proposeTasks(): void {
    this.runCommand('Предложения задач созданы.', this.goalsApi.proposeTasks(this.goalId));
  }

  protected complete(): void {
    this.runCommand('Цель завершена.', this.goalsApi.complete(this.goalId));
  }

  protected runAnalysis(): void {
    const repositoryName = this.goal()?.repositoryName;
    if (!repositoryName) {
      return;
    }
    this.runCommand('Анализ Project Manager запущен.', this.goalsApi.runAnalysis(repositoryName));
  }

  protected openReplanDialog(): void {
    this.replanReasonControl.reset('');
    this.replanDialogVisible.set(true);
    setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('[data-testid="goal-replan-reason"]')?.focus();
    });
  }

  protected submitReplan(): void {
    const repositoryName = this.goal()?.repositoryName;
    const reason = this.replanReasonControl.value.trim();
    if (!repositoryName || !reason) {
      this.replanReasonControl.markAsTouched();
      return;
    }

    this.runCommand('Перепланирование Project Manager запущено.', this.goalsApi.runReplan(repositoryName, reason), () => {
      this.closeReplanDialog();
    });
  }

  protected closeReplanDialog(): void {
    this.replanDialogVisible.set(false);
    this.replanReasonControl.reset('');
  }

  protected openReasonDialog(action: ReasonAction): void {
    this.pendingReasonAction.set(action);
    this.reasonControl.reset('');
    this.reasonDialogVisible.set(true);
    setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('[data-testid="goal-reason"]')?.focus();
    });
  }

  protected submitReasonAction(): void {
    const action = this.pendingReasonAction();
    const reason = this.reasonControl.value.trim();
    if (!action || !reason) {
      this.reasonControl.markAsTouched();
      return;
    }

    const request =
      action === 'reject'
        ? this.goalsApi.reject(this.goalId, reason)
        : this.goalsApi.markStale(this.goalId, reason);
    this.runCommand(action === 'reject' ? 'Цель отклонена.' : 'Цель помечена устаревшей.', request, () => {
      this.closeReasonDialog();
    });
  }

  protected closeReasonDialog(): void {
    this.reasonDialogVisible.set(false);
    this.pendingReasonAction.set(undefined);
    this.reasonControl.reset('');
  }

  protected canApprove(goal: ProjectGoalDto): boolean {
    return goal.status === 'proposed' && canUseCapability(this.session.session(), 'canApproveProjectGoals');
  }

  protected canProposeTasks(goal: ProjectGoalDto): boolean {
    return (
      (goal.status === 'approved' || goal.status === 'active') &&
      canUseCapability(this.session.session(), 'canProposeProjectGoalTasks')
    );
  }

  protected canComplete(goal: ProjectGoalDto): boolean {
    return goal.status === 'active' && canUseCapability(this.session.session(), 'canCompleteProjectGoals');
  }

  protected canMarkStale(goal: ProjectGoalDto): boolean {
    return (
      !['completed', 'rejected', 'stale'].includes(goal.status) &&
      canUseCapability(this.session.session(), 'canMarkProjectGoalsStale')
    );
  }

  protected canRunProjectManager(): boolean {
    return canUseCapability(this.session.session(), 'canRunProjectManager');
  }

  protected reasonDialogTitle(): string {
    return this.pendingReasonAction() === 'reject' ? 'Отклонить цель' : 'Пометить цель устаревшей';
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

  protected statusLabel(status: string): string {
    return statusLabel(status);
  }

  protected taskStatusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' {
    return statusSeverity(status);
  }

  protected formatDate(value: string | undefined): string {
    return formatDate(value);
  }

  protected truncate(value: string | undefined, max?: number): string {
    return truncate(value, max);
  }

  protected isReplanClassified(event: ProjectGoalAuditEventDto): boolean {
    return event.kind === 'project_goal_replan_classified';
  }

  protected auditPayloadValue(event: ProjectGoalAuditEventDto, key: 'decision' | 'rationale'): string {
    const value = event.payload?.[key];
    return typeof value === 'string' ? value : '';
  }

  protected nextStepText(goal: ProjectGoalDto): string {
    if (goal.status === 'proposed') {
      return 'Одобрить или отклонить цель после проверки проблемы, результата, метрик и доказательств.';
    }
    if (goal.status === 'approved') {
      return 'Предложить задачи из черновиков или запустить перепланирование, если контекст изменился.';
    }
    if (goal.status === 'active') {
      return 'Проверить связанные задачи и завершить цель после выполнения метрик успеха.';
    }
    if (goal.status === 'completed') {
      return 'Цель завершена. Используйте аудит и связанные задачи как историю исполнения.';
    }
    if (goal.status === 'rejected') {
      return 'Цель отклонена. Причина отклонения зафиксирована ниже.';
    }
    if (goal.status === 'stale') {
      return 'Цель устарела. Запустите новый анализ, если нужен обновленный план.';
    }
    return 'Проверьте состояние цели и выберите доступное действие.';
  }

  protected auditEventLabel(kind: string): string {
    const labels: Record<string, string> = {
      project_goal_created: 'Цель предложена',
      goal_proposed: 'Цель предложена',
      project_goal_approved: 'Цель одобрена',
      goal_approved: 'Цель одобрена',
      project_goal_activated: 'Цель активирована',
      tasks_proposed: 'Задачи предложены',
      project_goal_completed: 'Цель завершена',
      goal_completed: 'Цель завершена',
      project_goal_rejected: 'Цель отклонена',
      goal_rejected: 'Цель отклонена',
      project_goal_stale: 'Цель устарела',
      goal_marked_stale: 'Цель устарела',
      project_goal_replan_classified: 'Перепланирование классифицировано',
    };
    return labels[kind] ?? statusLabel(kind);
  }

  private runCommand(
    successMessage: string,
    request: Observable<ProjectGoalCommandResponseDto | ProjectGoalProposeTasksResponseDto | unknown>,
    beforeRefresh?: () => void,
  ): void {
    this.submitting.set(true);
    this.error.set(undefined);
    request.subscribe({
      next: () => {
        beforeRefresh?.();
        this.notice.set(successMessage);
        this.messages.add({ severity: 'success', summary: successMessage });
        this.submitting.set(false);
        this.load();
      },
      error: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.error.set(message);
        this.messages.add({ severity: 'error', summary: 'Действие не выполнено', detail: message });
        this.submitting.set(false);
      },
    });
  }
}
