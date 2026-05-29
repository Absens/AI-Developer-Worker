import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, ParamMap, Router, RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';

import { ProjectAnalysisDto, ProjectGoalDto, ProjectGoalStatusDto } from '../models/human-api.dto';
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
  truncate,
} from '../utils/task-ui';

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
          <div class="project-manager-actions">
            <button
              pButton
              type="button"
              data-testid="goals-run-analysis"
              icon="pi pi-sitemap"
              label="Запустить анализ"
              [disabled]="runningAnalysis()"
              (click)="runAnalysis()"
            ></button>
            <div class="strategy-run">
              <input
                pInputText
                type="text"
                data-testid="goals-strategy-brief"
                [formControl]="strategyBriefControl"
                maxlength="2000"
                placeholder="Strategy brief"
              />
              <button
                pButton
                type="button"
                data-testid="goals-run-strategy"
                icon="pi pi-compass"
                label="Запустить strategy"
                [disabled]="runningStrategy()"
                (click)="runStrategy()"
              ></button>
            </div>
          </div>
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
      <div class="muted" data-testid="goals-filter-summary">{{ goalFilterSummary() }}</div>

      @if (notice(); as message) {
        <p-message severity="success" [text]="message" />
      }

      @if (error(); as message) {
        <p-message severity="error" [text]="message" />
      }

      @if (latestStrategy(); as analysis) {
        <section class="surface strategy-summary" data-testid="goals-strategy-summary">
          <div class="strategy-summary__header">
            <div>
              <span class="eyebrow">{{ analysis.id }}</span>
              <h2>{{ analysis.strategy?.summary || analysis.summary }}</h2>
            </div>
            <span>{{ formatDate(analysis.createdAt) }}</span>
          </div>

          @if (analysis.strategy; as strategy) {
            @if (strategy.analysisLenses.length) {
              <div class="tag-row">
                @for (lens of strategy.analysisLenses; track lens.lens) {
                  <p-tag [value]="lens.lens" severity="secondary" />
                }
              </div>
            }

            @if (strategy.opportunities.length) {
              <div class="strategy-opportunities">
                @for (opportunity of strategy.opportunities; track opportunity.opportunityId) {
                  <article class="strategy-opportunity">
                    <div>
                      <span class="eyebrow">{{ opportunity.dimension }} · {{ opportunity.architectVerdict }}</span>
                      <h3>{{ opportunity.title }}</h3>
                      <p>{{ opportunity.rationale }}</p>
                    </div>
                    <div class="tag-row">
                      <p-tag [value]="'Confidence: ' + opportunity.confidence" severity="info" />
                      <p-tag [value]="opportunity.priority" [severity]="prioritySeverity(opportunity.priority)" />
                      <p-tag [value]="opportunity.recommendedNextStep" severity="secondary" />
                    </div>
                    @if (opportunity.redTeamNotes.length) {
                      <ul>
                        @for (note of opportunity.redTeamNotes; track note) {
                          <li>{{ note }}</li>
                        }
                      </ul>
                    }
                  </article>
                }
              </div>
            }
          }
        </section>
      }

      @if (loading()) {
        <div class="loading-row" aria-live="polite">
          <p-progressSpinner ariaLabel="Загрузка целей" />
          <span>Загрузка целей</span>
        </div>
      } @else if (goals().length === 0) {
        <div class="empty-state surface">
          <i class="pi pi-sitemap" aria-hidden="true"></i>
          <h2>{{ emptyGoalTitle() }}</h2>
          <p>{{ emptyGoalDescription() }}</p>
          @if (statusFilter.value !== 'all') {
            <button
              pButton
              type="button"
              data-testid="goals-show-all"
              icon="pi pi-list"
              label="Показать все цели"
              severity="secondary"
              (click)="showAllGoals()"
            ></button>
          }
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
                  <p-tag [value]="'Приоритет: ' + priorityLabel(goal.priority)" [severity]="prioritySeverity(goal.priority)" />
                  <p-tag [value]="'Риск: ' + riskLabel(goal.riskLevel)" [severity]="riskSeverity(goal.riskLevel)" />
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

                <div class="goal-summary-grid">
                  <div class="summary-block">
                    <h3>Проблема</h3>
                    <p>{{ truncate(goal.problemStatement, 320) || 'Проблема не указана.' }}</p>
                  </div>
                  <div class="summary-block">
                    <h3>Ожидаемый результат</h3>
                    <p>{{ truncate(goal.desiredOutcome, 320) || 'Результат не указан.' }}</p>
                  </div>
                </div>

                <div class="summary-block">
                  <h3>Метрики успеха</h3>
                  @if (goal.successMetrics.length) {
                    <ul class="compact-list">
                      @for (metric of goal.successMetrics.slice(0, 3); track metric) {
                        <li>{{ metric }}</li>
                      }
                    </ul>
                  } @else {
                    <p>Метрики не указаны.</p>
                  }
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
  styles: [
    `
      .project-manager-actions {
        display: grid;
        gap: 0.5rem;
        justify-items: end;
      }

      .strategy-run {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .strategy-run input {
        min-width: min(26rem, 100%);
      }

      .strategy-summary {
        display: grid;
        gap: 1rem;
      }

      .strategy-summary__header {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: flex-start;
      }

      .strategy-opportunities {
        display: grid;
        gap: 0.75rem;
      }

      .strategy-opportunity {
        display: grid;
        gap: 0.5rem;
        padding-block: 0.75rem;
        border-top: 1px solid var(--surface-border, var(--console-border));
      }
    `,
  ],
})
export class GoalsPageComponent implements OnInit {
  private readonly goalsApi = inject(ProjectGoalService);
  private readonly session = inject(SessionService);
  private readonly messages = inject(MessageService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly statusOptions: { label: string; value: GoalStatusFilter }[] = [
    { label: 'Все', value: 'all' },
    { label: 'Предложено', value: 'proposed' },
    { label: 'Одобрено', value: 'approved' },
    { label: 'Активно', value: 'active' },
    { label: 'Завершено', value: 'completed' },
    { label: 'Отклонено', value: 'rejected' },
    { label: 'Устарело', value: 'stale' },
  ];
  protected readonly statusFilter = new FormControl<GoalStatusFilter>('all', { nonNullable: true });
  protected readonly repositoryFilter = new FormControl<string>('', { nonNullable: true });
  protected readonly strategyBriefControl = new FormControl<string>('', { nonNullable: true });

  protected readonly goals = signal<ProjectGoalDto[]>([]);
  protected readonly linkedTaskCounts = signal<Record<string, number>>({});
  protected readonly loading = signal(false);
  protected readonly runningAnalysis = signal(false);
  protected readonly runningStrategy = signal(false);
  protected readonly strategyAnalyses = signal<ProjectAnalysisDto[]>([]);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly notice = signal<string | undefined>(undefined);

  private applyingUrl = false;
  private urlFiltersInitialized = false;

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      if (!this.applyUrlFilters(params)) {
        return;
      }
      this.applyingUrl = true;
      this.load(false);
      this.loadStrategyAnalyses();
      this.applyingUrl = false;
    });
  }

  protected load(refreshStrategyAnalyses = true): void {
    this.loading.set(true);
    this.error.set(undefined);
    this.syncUrl();
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
          if (refreshStrategyAnalyses) {
            this.loadStrategyAnalyses();
          }
        },
        error: (error: unknown) => {
          this.error.set(this.errorMessage(error));
          this.loading.set(false);
        },
      });
  }

  protected loadStrategyAnalyses(): void {
    this.goalsApi
      .listAnalyses({
        repositoryName: this.repositoryFilter.value.trim() || undefined,
        analysisKind: 'strategy',
      })
      .subscribe({
        next: (response) => this.strategyAnalyses.set(response.analyses),
        error: (error: unknown) => this.error.set(this.errorMessage(error)),
      });
  }

  protected runAnalysis(): void {
    const repositoryName = this.repositoryFilter.value.trim();
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
        const message = this.errorMessage(error);
        this.error.set(message);
        this.messages.add({ severity: 'error', summary: 'Анализ не запущен', detail: message });
        this.runningAnalysis.set(false);
      },
    });
  }

  protected runStrategy(): void {
    const repositoryName = this.repositoryFilter.value.trim() || this.latestStrategy()?.repositoryName;
    if (!repositoryName) {
      this.error.set('Укажите репозиторий для strategy run.');
      return;
    }
    const brief = this.strategyBriefControl.value.trim();
    this.runningStrategy.set(true);
    this.error.set(undefined);
    this.goalsApi.runStrategy(repositoryName, brief).subscribe({
      next: () => {
        this.notice.set('Strategy Project Manager запущен.');
        this.runningStrategy.set(false);
        this.load(false);
        this.loadStrategyAnalyses();
      },
      error: (error: unknown) => {
        this.runningStrategy.set(false);
        this.error.set(this.errorMessage(error));
      },
    });
  }

  protected latestStrategy(): ProjectAnalysisDto | undefined {
    return this.strategyAnalyses()[0];
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

  protected showAllGoals(): void {
    this.statusFilter.setValue('all');
    this.load();
  }

  protected goalFilterSummary(): string {
    const repositoryName = this.repositoryFilter.value.trim();
    const status = this.statusFilter.value;
    const statusText = status === 'all' ? 'Показаны все цели' : `Статус: ${projectGoalStatusLabel(status)}`;
    return repositoryName ? `${statusText}; репозиторий: ${repositoryName}` : statusText;
  }

  protected emptyGoalTitle(): string {
    return this.statusFilter.value === 'all'
      ? 'Цели не найдены'
      : `Нет целей со статусом ${projectGoalStatusLabel(this.statusFilter.value)}`;
  }

  protected emptyGoalDescription(): string {
    return this.statusFilter.value === 'all'
      ? 'Запустите анализ Project Manager для репозитория или проверьте имя репозитория.'
      : 'Текущий фильтр скрывает цели в других состояниях. Переключитесь на все цели, чтобы увидеть одобренные, активные и завершенные цели.';
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

  protected truncate(value: string | undefined, max?: number): string {
    return truncate(value, max);
  }

  protected formatDate(value: string): string {
    return formatDate(value);
  }

  private applyUrlFilters(params: ParamMap): boolean {
    const requestedStatus = params.get('status');
    const nextStatus = this.statusOptions.some((option) => option.value === requestedStatus)
      ? (requestedStatus as GoalStatusFilter)
      : 'all';
    const nextRepositoryName = params.get('repositoryName') ?? '';
    const changed =
      !this.urlFiltersInitialized ||
      this.statusFilter.value !== nextStatus ||
      this.repositoryFilter.value !== nextRepositoryName;
    this.urlFiltersInitialized = true;
    if (!changed) {
      return false;
    }
    this.statusFilter.setValue(nextStatus, { emitEvent: false });
    this.repositoryFilter.setValue(nextRepositoryName, { emitEvent: false });
    return true;
  }

  private syncUrl(): void {
    if (this.applyingUrl || !this.urlFiltersInitialized) {
      return;
    }
    const repositoryName = this.repositoryFilter.value.trim();
    const status = this.statusFilter.value;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        ...(status !== 'all' ? { status } : {}),
        ...(repositoryName ? { repositoryName } : {}),
      },
      replaceUrl: true,
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
