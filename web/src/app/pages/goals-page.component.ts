import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';

import { ProjectGoalDto, ProjectGoalStatusDto } from '../models/human-api.dto';
import { ProjectGoalService } from '../services/project-goal.service';
import { SessionService } from '../services/session.service';
import { canUseCapability, formatDate, truncate } from '../utils/task-ui';

type GoalStatusFilter = ProjectGoalStatusDto | 'all';

@Component({
  selector: 'app-goals-page',
  imports: [
    ButtonModule,
    CommonModule,
    InputTextModule,
    MessageModule,
    ProgressSpinnerModule,
    ReactiveFormsModule,
    RouterLink,
    SelectModule,
    TagModule,
  ],
  template: `
    <section class="page goals-page" data-testid="goals-page">
      <header class="page__header">
        <div>
          <h1>Цели проекта</h1>
          <p>Отслеживайте цели Project Manager, риск, доказательства и связь с задачами.</p>
        </div>
        @if (canRunProjectManager()) {
          <button
            pButton
            type="button"
            data-testid="goals-run-analysis"
            icon="pi pi-sitemap"
            label="Запустить анализ"
            [disabled]="runningAnalysis()"
            (click)="runAnalysis()"
          ></button>
        }
      </header>

      <div class="surface filter-grid filter-grid--compact">
        <label class="field">
          <span>Статус</span>
          <p-select
            [formControl]="statusFilter"
            [options]="statusOptions"
            optionLabel="label"
            optionValue="value"
            (onChange)="load()"
          />
        </label>
        <label class="field">
          <span>Репозиторий</span>
          <input
            pInputText
            type="text"
            [formControl]="repositoryFilter"
            placeholder="developer"
            (keyup.enter)="load()"
          />
        </label>
        <div class="filter-actions">
          <button
            pButton
            type="button"
            data-testid="goals-refresh"
            icon="pi pi-refresh"
            label="Обновить"
            severity="secondary"
            (click)="load()"
          ></button>
        </div>
      </div>

      @if (notice(); as message) {
        <p-message severity="success" [text]="message" />
      }

      @if (error(); as message) {
        <p-message severity="error" [text]="message" />
      }

      @if (loading()) {
        <div class="loading-row" aria-live="polite">
          <p-progressSpinner ariaLabel="Загрузка целей" />
          <span>Загрузка целей</span>
        </div>
      } @else if (goals().length === 0) {
        <div class="empty-state surface">
          <i class="pi pi-sitemap" aria-hidden="true"></i>
          <h2>Цели не найдены</h2>
          <p>Измените фильтры или запустите анализ Project Manager для репозитория.</p>
        </div>
      } @else {
        <div class="goal-list">
          @for (goal of goals(); track goal.id) {
            <article class="surface goal-row" [attr.data-testid]="'goal-row-' + goal.id">
              <div class="goal-row__main">
                <div class="eyebrow">{{ goal.id }}</div>
                <h2><a [routerLink]="['/goals', goal.id]">{{ goal.title }}</a></h2>
                <div class="tag-row">
                  <p-tag [value]="goalStatusLabel(goal.status)" [severity]="goalStatusSeverity(goal.status)" />
                  <p-tag [value]="'Приоритет: ' + goal.priority" [severity]="prioritySeverity(goal.priority)" />
                  <p-tag [value]="'Риск: ' + goal.riskLevel" [severity]="riskSeverity(goal.riskLevel)" />
                  <p-tag [value]="goal.repositoryName" severity="secondary" />
                </div>

                <div class="field-grid field-grid--compact">
                  <div>
                    <span class="field-label">Связанные задачи</span>
                    <span>{{ linkedCount(goal) }}</span>
                  </div>
                  <div>
                    <span class="field-label">Черновики задач</span>
                    <span>{{ goal.suggestedTaskProposals.length }}</span>
                  </div>
                  <div>
                    <span class="field-label">Source run id</span>
                    <span>{{ goal.sourceRunId || 'Не указан' }}</span>
                  </div>
                  <div>
                    <span class="field-label">Обновлено</span>
                    <span>{{ formatDate(goal.updatedAt) }}</span>
                  </div>
                </div>

                <div class="summary-block">
                  <h3>Доказательства</h3>
                  @if (evidenceSummary(goal)) {
                    <p>{{ evidenceSummary(goal) }}</p>
                  } @else {
                    <p>Нет доказательств.</p>
                  }
                </div>
              </div>
            </article>
          }
        </div>
      }
    </section>
  `,
})
export class GoalsPageComponent implements OnInit {
  private readonly goalsApi = inject(ProjectGoalService);
  private readonly session = inject(SessionService);
  private readonly messages = inject(MessageService);

  protected readonly statusOptions: { label: string; value: GoalStatusFilter }[] = [
    { label: 'Предложено', value: 'proposed' },
    { label: 'Одобрено', value: 'approved' },
    { label: 'Активно', value: 'active' },
    { label: 'Завершено', value: 'completed' },
    { label: 'Отклонено', value: 'rejected' },
    { label: 'Устарело', value: 'stale' },
    { label: 'Все', value: 'all' },
  ];
  protected readonly statusFilter = new FormControl<GoalStatusFilter>('proposed', { nonNullable: true });
  protected readonly repositoryFilter = new FormControl<string>('', { nonNullable: true });

  protected readonly goals = signal<ProjectGoalDto[]>([]);
  protected readonly linkedTaskCounts = signal<Record<string, number>>({});
  protected readonly loading = signal(false);
  protected readonly runningAnalysis = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly notice = signal<string | undefined>(undefined);

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(undefined);
    const repositoryName = this.repositoryFilter.value.trim();
    const status = this.statusFilter.value === 'all' ? undefined : this.statusFilter.value;
    this.goalsApi
      .list({
        ...(repositoryName ? { repositoryName } : {}),
        ...(status ? { status } : {}),
      })
      .subscribe({
        next: (response) => {
          this.goals.set(response.goals);
          this.linkedTaskCounts.set(response.linkedTaskCounts);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          this.error.set(error instanceof Error ? error.message : String(error));
          this.loading.set(false);
        },
      });
  }

  protected runAnalysis(): void {
    const repositoryName = this.repositoryFilter.value.trim() || this.goals()[0]?.repositoryName;
    if (!repositoryName) {
      this.error.set('Укажите репозиторий для анализа.');
      return;
    }

    this.runningAnalysis.set(true);
    this.error.set(undefined);
    this.goalsApi.runAnalysis(repositoryName).subscribe({
      next: () => {
        this.notice.set('Анализ Project Manager запущен.');
        this.messages.add({ severity: 'success', summary: 'Анализ Project Manager запущен' });
        this.runningAnalysis.set(false);
        this.load();
      },
      error: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.error.set(message);
        this.messages.add({ severity: 'error', summary: 'Анализ не запущен', detail: message });
        this.runningAnalysis.set(false);
      },
    });
  }

  protected canRunProjectManager(): boolean {
    return canUseCapability(this.session.session(), 'canRunProjectManager');
  }

  protected linkedCount(goal: ProjectGoalDto): number {
    return this.linkedTaskCounts()[goal.id] ?? 0;
  }

  protected evidenceSummary(goal: ProjectGoalDto): string {
    return truncate(
      goal.evidenceRefs
        .map((evidence) => evidence.summary || `${evidence.kind}: ${evidence.ref}`)
        .filter(Boolean)
        .join(' '),
      260,
    );
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

  protected prioritySeverity(priority: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (priority === 'critical') {
      return 'danger';
    }
    if (priority === 'high') {
      return 'warn';
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

  protected formatDate(value: string): string {
    return formatDate(value);
  }
}
