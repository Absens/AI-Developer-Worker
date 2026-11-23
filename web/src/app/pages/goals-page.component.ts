import { CommonModule, DOCUMENT } from '@angular/common';
import { Component, DestroyRef, Injector, OnInit, afterNextRender, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, ParamMap, Params, Router, RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { Subscription } from 'rxjs';

import { EvidenceRefDto, ProjectAnalysisDto, ProjectGoalDto, ProjectGoalStatusDto } from '../models/human-api.dto';
import { ProjectGoalService, StrategyRunResult } from '../services/project-goal.service';
import { RepositoryDirectoryService } from '../services/repository-directory.service';
import { SessionService } from '../services/session.service';
import {
  canUseCapability,
  formatDate,
  projectConfidenceLabel,
  projectGoalPriorityLabel,
  projectGoalPrioritySeverity,
  projectGoalRiskLabel,
  projectGoalRiskSeverity,
  projectGoalStatusLabel,
  projectGoalStatusSeverity,
  projectStrategyArchitectVerdictLabel,
  projectStrategyDimensionLabel,
  projectStrategyNextStepLabel,
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
          <p>Просматривайте цели, их ожидаемые результаты и связанные задачи.</p>
        </div>
      </header>

      <section class="surface goal-controls" aria-label="Фильтры и анализ целей">
        <div class="goal-filters">
          <label class="field" for="goals-status">
            <span id="goals-status-label">Статус</span>
            <p-select
              inputId="goals-status"
              ariaLabelledBy="goals-status-label"
              [formControl]="statusFilter"
              [options]="statusOptions"
              optionLabel="label"
              optionValue="value"
              (onChange)="load()"
            />
          </label>
          <label class="field" for="goals-repository">
            <span id="goals-repository-label">Репозиторий</span>
            @if (repositoryOptions().length) {
              <p-select
                inputId="goals-repository"
                data-testid="goals-repository"
                ariaLabelledBy="goals-repository-label"
                [formControl]="repositoryFilter"
                [options]="repositoryOptions()"
                optionLabel="label"
                optionValue="id"
                [filter]="true"
                filterBy="label"
                ariaFilterLabel="Поиск репозитория"
                (onChange)="load()"
              />
            } @else {
              <input pInputText id="goals-repository" type="text" data-testid="goals-repository"
                [formControl]="repositoryFilter" placeholder="Имя репозитория" (keyup.enter)="load()" />
            }
          </label>
          <div class="filter-actions">
            <button
              pButton
              type="button"
              data-testid="goals-refresh"
              icon="pi pi-refresh"
              label="Обновить"
              severity="secondary"
              [loading]="loading()"
              (click)="load()"
            ></button>
            @if (canRunProjectManager()) {
              <button
                pButton
                type="button"
                data-testid="goals-run-analysis"
                icon="pi pi-sitemap"
                label="Запустить анализ"
                [loading]="runningAnalysis()"
                [disabled]="runningStrategy()"
                (click)="runAnalysis()"
              ></button>
            }
          </div>
        </div>
        @if (canRunProjectManager()) {
          <div class="strategy-run">
            <label class="field">
              <span>Задание для стратегии <span class="optional">(необязательно)</span></span>
              <input
                pInputText
                type="text"
                data-testid="goals-strategy-brief"
                [formControl]="strategyBriefControl"
                maxlength="2000"
              />
            </label>
            <button
              pButton
              type="button"
              data-testid="goals-run-strategy"
              icon="pi pi-compass"
              label="Запустить стратегию"
              severity="secondary"
              [loading]="runningStrategy()"
              [disabled]="!repositoryFilter.value.trim() || runningAnalysis()"
              (click)="runStrategy()"
            ></button>
          </div>
          @if (!repositoryFilter.value.trim()) {
            <p class="muted strategy-hint">Выберите репозиторий, чтобы запустить стратегию.</p>
          }
        }
      </section>

      @if (notice(); as message) {
        <p-message severity="success" [text]="message" />
      }

      @if (error(); as message) {
        <p-message severity="error" [text]="message" />
      }

      @if (latestStrategy(); as analysis) {
        <details class="surface strategy-summary" data-testid="goals-strategy-summary" [open]="strategyOpen()">
          <summary id="goals-strategy-result">
            <strong>Результаты стратегии</strong>
            <span class="muted">{{ directory.repoLabel(analysis.repositoryName) }} · {{ formatDate(analysis.createdAt) }}</span>
          </summary>
          <div class="strategy-content">
            <h2>{{ analysis.strategy?.summary || analysis.summary }}</h2>
            @if (lastStrategyRun(); as run) {
              <section class="strategy-subsection" data-testid="goals-created-goals">
                <h3>Созданные цели</h3>
                @if (run.goalIds.length) {
                  <ul class="compact-list">
                    @for (id of run.goalIds; track id; let index = $index) {
                      <li><a [attr.data-testid]="'strategy-goal-link-' + id" [routerLink]="['/goals', id]"
                        [queryParams]="filterParams()">{{ createdGoalTitle(id, index) }}</a></li>
                    }
                  </ul>
                } @else {
                  <p>Новых целей нет.</p>
                }
              </section>
            }
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
                        <span class="eyebrow">
                          {{ strategyDimensionLabel(opportunity.dimension) }} · {{ architectVerdictLabel(opportunity.architectVerdict) }}
                        </span>
                        <h3>{{ opportunity.title }}</h3>
                        <p>{{ opportunity.rationale }}</p>
                      </div>
                      <div class="tag-row">
                        <p-tag [value]="confidenceLabel(opportunity.confidence)" severity="info" />
                        <p-tag [value]="priorityLabel(opportunity.priority)" [severity]="prioritySeverity(opportunity.priority)" />
                        <p-tag [value]="nextStepLabel(opportunity.recommendedNextStep)" severity="secondary" />
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

              @if (strategy.goalLinks.length) {
                <div class="strategy-subsection">
                  <h3>Связанные цели</h3>
                  <div class="goal-badge-list">
                    @for (link of strategy.goalLinks; track link.sourceOpportunityId + link.proposedGoalTitle) {
                      <div class="goal-badge">
                        <span class="goal-badge__title">{{ link.proposedGoalTitle }}</span>
                        <span class="muted">Источник: {{ link.sourceOpportunityId }}</span>
                        @if (link.evidenceRefs.length) {
                          <span class="muted">{{ evidenceSummaryFromRefs(link.evidenceRefs) }}</span>
                        }
                      </div>
                    }
                  </div>
                </div>
              }

              @if (strategy.questionsForHuman.length) {
                <div class="strategy-subsection">
                  <h3>Вопросы человеку</h3>
                  <div class="goal-badge-list">
                    @for (question of strategy.questionsForHuman; track question.question) {
                      <div class="goal-badge">
                        <span class="goal-badge__title">{{ question.question }}</span>
                        <span>{{ question.whyItMatters }}</span>
                        @if (question.relatedOpportunityTitle) {
                          <span class="muted">{{ question.relatedOpportunityTitle }}</span>
                        }
                      </div>
                    }
                  </div>
                </div>
              }
            }
          </div>
        </details>
      }

      <div class="goal-results" aria-live="polite">
        <span class="muted" data-testid="goals-filter-summary">{{ goalFilterSummary() }}</span>
        @if (!loading()) {
          <strong>Найдено {{ goals().length }}</strong>
        }
      </div>

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
                <h2><a [id]="'goal-link-' + goal.id" [routerLink]="['/goals', goal.id]" [queryParams]="filterParams()">{{ goal.title }}</a></h2>
                <div class="tag-row">
                  <p-tag [value]="goalStatusLabel(goal.status)" [severity]="goalStatusSeverity(goal.status)" />
                  <p-tag [value]="'Приоритет: ' + priorityLabel(goal.priority)" [severity]="prioritySeverity(goal.priority)" />
                  <p-tag [value]="'Риск: ' + riskLabel(goal.riskLevel)" [severity]="riskSeverity(goal.riskLevel)" />
                  <p-tag [value]="directory.repoLabel(goal.repositoryName)" severity="secondary" />
                </div>

                <p class="goal-row__counts muted">
                  <span>Связанные задачи: {{ linkedCount(goal) }}</span>
                  <span>Черновики задач: {{ goal.suggestedTaskProposals.length }}</span>
                </p>

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

                <details class="goal-row__details">
                  <summary>Метрики и основания</summary>
                  <div class="goal-row__extra">
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
                    <div class="field-grid field-grid--compact">
                      <div>
                        <span class="field-label">ID цели</span>
                        <span>{{ goal.id }}</span>
                      </div>
                      <div>
                        <span class="field-label">ID запуска</span>
                        <span>{{ goal.sourceRunId || 'Не указан' }}</span>
                      </div>
                      <div>
                        <span class="field-label">Обновлено</span>
                        <span>{{ formatDate(goal.updatedAt) }}</span>
                      </div>
                    </div>
                  </div>
                </details>
              </div>
            </article>
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      .goal-controls { display: grid; gap: 12px; }
      .goal-filters {
        display: grid;
        grid-template-columns: minmax(0, 190px) minmax(0, 1fr) auto;
        align-items: end;
        gap: 12px;
      }
      .strategy-run {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: end;
        gap: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--console-border);
      }
      .strategy-run button { justify-self: start; }
      .optional { font-weight: 400; }
      .strategy-hint { margin: 0; overflow-wrap: anywhere; }
      .goal-results, .goal-row__counts {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 16px;
      }
      .goal-results { justify-content: space-between; }
      .goal-row__counts { margin: 0; font-size: .875rem; }
      .goal-row__main { overflow-wrap: anywhere; }
      .goal-row h2 { margin: 0; font-size: 1.125rem; }
      .goal-row h2 a { color: var(--console-link); }
      .strategy-summary summary, .goal-row__details summary {
        cursor: pointer;
        color: var(--console-link);
        min-height: 32px;
        align-content: center;
      }
      .strategy-summary summary span { margin-inline-start: 10px; }
      .strategy-content, .goal-row__extra { display: grid; gap: 12px; margin-top: 12px; }
      .strategy-content { overflow-wrap: anywhere; }
      .strategy-content h2 { margin: 0; font-size: 1.125rem; }
      .goal-row__details { border-top: 1px solid var(--console-border); padding-top: 6px; }

      @media (max-width: 1050px) {
        .goal-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .goal-filters .filter-actions { grid-column: 1 / -1; }
      }
      @media (max-width: 560px) {
        .goal-filters, .strategy-run { grid-template-columns: minmax(0, 1fr); }
        .strategy-summary summary span { display: block; margin-inline-start: 0; }
      }

      .strategy-opportunity h3, .strategy-opportunity p { margin: 4px 0 0; }

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

      .strategy-subsection {
        display: grid;
        gap: 0.5rem;
      }

      .strategy-subsection h3 {
        margin: 0;
        font-size: 1rem;
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
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  protected readonly directory = inject(RepositoryDirectoryService);

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
  private readonly repositoryValue = toSignal(this.repositoryFilter.valueChanges, { initialValue: '' });
  protected readonly repositoryOptions = computed(() => {
    const options = this.directory.options();
    if (!options.length) return [];
    const current = this.repositoryValue().trim();
    const fallback = current && !options.some((option) => option.id === current)
      ? [{ id: current, label: this.directory.repoLabel(current) }]
      : [];
    return [{ id: '', label: 'Все репозитории' }, ...options, ...fallback];
  });
  protected readonly strategyBriefControl = new FormControl<string>('', { nonNullable: true });

  protected readonly goals = signal<ProjectGoalDto[]>([]);
  protected readonly linkedTaskCounts = signal<Record<string, number>>({});
  protected readonly loading = signal(false);
  protected readonly runningAnalysis = signal(false);
  protected readonly runningStrategy = signal(false);
  protected readonly strategyAnalyses = signal<ProjectAnalysisDto[]>([]);
  protected readonly lastStrategyRun = signal<StrategyRunResult | undefined>(undefined);
  protected readonly strategyOpen = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly notice = signal<string | undefined>(undefined);

  private applyingUrl = false;
  private urlFiltersInitialized = false;
  private goalsRequest?: Subscription;
  private analysesRequest?: Subscription;
  private pendingFocus?: string;

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.pendingFocus = params.get('focus') || undefined;
      if (!this.applyUrlFilters(params)) {
        if (!this.loading()) this.restoreFocus();
        return;
      }
      this.applyingUrl = true;
      this.load(false);
      this.loadStrategyAnalyses();
      this.applyingUrl = false;
    });
  }

  protected load(refreshStrategyAnalyses = true): void {
    this.goalsRequest?.unsubscribe();
    this.loading.set(true);
    this.error.set(undefined);
    const repositoryName = this.repositoryFilter.value.trim();
    if (repositoryName !== this.repositoryFilter.value) this.repositoryFilter.setValue(repositoryName);
    this.syncUrl();
    const status = this.statusFilter.value === 'all' ? undefined : this.statusFilter.value;
    this.goalsRequest = this.goalsApi
      .list({
        ...(repositoryName ? { repositoryName } : {}),
        ...(status ? { status } : {}),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.goals.set(response.goals);
          this.linkedTaskCounts.set(response.linkedTaskCounts);
          this.loading.set(false);
          this.restoreFocus();
          if (refreshStrategyAnalyses) {
            this.loadStrategyAnalyses();
          }
        },
        error: (error: unknown) => {
          this.error.set(this.errorMessage(error));
          this.goals.set([]);
          this.loading.set(false);
          this.restoreFocus();
        },
      });
  }

  protected loadStrategyAnalyses(): void {
    this.analysesRequest?.unsubscribe();
    this.analysesRequest = this.goalsApi
      .listAnalyses({
        repositoryName: this.repositoryFilter.value.trim() || undefined,
        analysisKind: 'strategy',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => this.strategyAnalyses.set(response.analyses),
        error: (error: unknown) => this.error.set(this.errorMessage(error)),
      });
  }

  protected runAnalysis(): void {
    if (!this.canRunProjectManager() || this.runningAnalysis() || this.runningStrategy()) return;
    const repositoryName = this.repositoryFilter.value.trim();
    if (!repositoryName) {
      this.error.set('Укажите репозиторий для анализа.');
      return;
    }

    this.runningAnalysis.set(true);
    this.error.set(undefined);
    this.goalsApi.runAnalysis(repositoryName).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
    if (!this.canRunProjectManager() || this.runningAnalysis() || this.runningStrategy()) return;
    const repositoryName = this.repositoryFilter.value.trim();
    if (!repositoryName) {
      this.error.set('Укажите репозиторий для запуска стратегии.');
      return;
    }
    const brief = this.strategyBriefControl.value.trim();
    this.runningStrategy.set(true);
    this.error.set(undefined);
    this.notice.set(undefined);
    this.strategyOpen.set(false);
    this.goalsApi.runStrategy(repositoryName, brief).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (run) => {
        this.runningStrategy.set(false);
        if (run.status !== 'completed') {
          this.error.set(run.diagnostic || 'Не удалось подтвердить завершение стратегии.');
          return;
        }
        this.lastStrategyRun.set(run);
        this.notice.set('Стратегия завершена.');
        this.strategyOpen.set(true);
        this.load(false);
        afterNextRender(() => this.document.getElementById('goals-strategy-result')?.focus(), { injector: this.injector });
      },
      error: (error: unknown) => {
        this.runningStrategy.set(false);
        this.error.set(this.errorMessage(error));
      },
    });
  }

  protected latestStrategy(): ProjectAnalysisDto | undefined {
    return this.lastStrategyRun()?.analysis ?? this.strategyAnalyses()[0];
  }

  protected createdGoalTitle(id: string, index: number): string {
    return this.goals().find((goal) => goal.id === id)?.title ?? `Открыть цель ${index + 1}`;
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

  protected evidenceSummaryFromRefs(evidenceRefs: EvidenceRefDto[]): string {
    return truncate(
      evidenceRefs
        .map((evidence) => evidence.summary || `${evidence.kind}: ${evidence.ref}`)
        .filter(Boolean)
        .join(' '),
      220,
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
    return repositoryName ? `${statusText} · ${this.directory.repoLabel(repositoryName)}` : statusText;
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

  protected strategyDimensionLabel(dimension: string): string {
    return projectStrategyDimensionLabel(dimension);
  }

  protected architectVerdictLabel(verdict: string): string {
    return projectStrategyArchitectVerdictLabel(verdict);
  }

  protected nextStepLabel(nextStep: string): string {
    return projectStrategyNextStepLabel(nextStep);
  }

  protected confidenceLabel(confidence: number): string {
    return projectConfidenceLabel(confidence);
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
    this.repositoryFilter.setValue(nextRepositoryName);
    return true;
  }

  private syncUrl(): void {
    if (this.applyingUrl || !this.urlFiltersInitialized) {
      return;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: this.filterParams(),
      replaceUrl: true,
    });
  }

  protected filterParams(): Params {
    const repositoryName = this.repositoryFilter.value.trim();
    const status = this.statusFilter.value;
    return {
      ...(status !== 'all' ? { status } : {}),
      ...(repositoryName ? { repositoryName } : {}),
    };
  }

  private restoreFocus(): void {
    const id = this.pendingFocus;
    if (!id) return;
    this.pendingFocus = undefined;
    afterNextRender(() => {
      (this.document.getElementById('goal-link-' + id) ??
        this.document.getElementById('goals-status'))?.focus();
    }, { injector: this.injector });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
