import { DOCUMENT, Location } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { EMPTY, Subject, catchError, debounceTime, map, switchMap } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';

import { TaskDetailPanelComponent } from '../components/task-detail-panel.component';
import { TaskStatusDto, TaskSummaryDto } from '../models/human-api.dto';
import { SessionService } from '../services/session.service';
import { TaskApiService, TaskListFilters } from '../services/task-api.service';
import { RepositoryDirectoryService } from '../services/repository-directory.service';
import {
  QUEUE_GROUP_STATUSES,
  TASK_STATUSES,
  canUseCapability,
  formatDate,
  projectGoalPriorityLabel,
  statusLabel,
  statusSeverity,
  truncate,
} from '../utils/task-ui';

interface QueueGroup {
  status: TaskStatusDto | 'other';
  tasks: TaskSummaryDto[];
}

const ATTENTION_STATUSES: TaskStatusDto[] = ['awaiting_human', 'failed', 'blocked', 'human_testing', 'review'];
const GROUP_ORDER = [
  ...ATTENTION_STATUSES,
  ...QUEUE_GROUP_STATUSES.filter((status) => !ATTENTION_STATUSES.includes(status)),
];

const EMPTY_FILTERS = {
  search: '',
  status: [] as TaskStatusDto[],
  repository: '',
  queue: '',
  priority: '',
  worker: '',
  tag: '',
};

@Component({
  selector: 'app-queue-page',
  imports: [
    ButtonModule,
    InputTextModule,
    MessageModule,
    MultiSelectModule,
    SelectModule,
    ReactiveFormsModule,
    RouterLink,
    SkeletonModule,
    TagModule,
    TaskDetailPanelComponent,
  ],
  template: `
    <section class="page queue-page" data-testid="queue-page" [class.queue-page--selected]="selectedId()">
      <header class="page__header queue-header">
        <h1>Очередь</h1>
        @if (canCreateTask()) {
          <a pButton routerLink="/new" [queryParams]="queueQuery()['repository'] ? { project: queueQuery()['repository'] } : null"
            icon="pi pi-plus" label="Создать задачу" data-testid="queue-create-task"></a>
        }
      </header>

      <div class="queue-layout" data-testid="queue-layout">
        <div class="queue-left">
          <form class="surface queue-filters" [formGroup]="filters" aria-label="Фильтры задач" (ngSubmit)="applyFilters()">
            <label class="field">
              <span>Поиск задач</span>
              <span class="queue-search">
                <i class="pi pi-search" aria-hidden="true"></i>
                <input pInputText id="queue-search" data-testid="queue-search" type="search" formControlName="search"
                  placeholder="Название, ID или путь GitLab" maxlength="200" />
              </span>
            </label>
            <div class="queue-filter-main">
              <label class="field" for="queue-status">
                <span>Статус</span>
                <p-multiselect
                  inputId="queue-status"
                  formControlName="status"
                  ariaLabel="Статус"
                  [options]="statusOptions"
                  optionLabel="label"
                  optionValue="value"
                  placeholder="Любой статус"
                  [maxSelectedLabels]="1"
                  selectedItemsLabel="Выбрано: {0}"
                  [showClear]="true"
                  appendTo="body"
                />
              </label>
              <label class="field" for="queue-repository">
                <span id="queue-repository-label">Репозиторий</span>
                <p-select inputId="queue-repository" data-testid="queue-repository" ariaLabelledBy="queue-repository-label"
                  formControlName="repository" [options]="repositoryOptions()" optionLabel="label" optionValue="id"
                  placeholder="Все репозитории" [filter]="true" ariaFilterLabel="Поиск репозитория"
                  emptyFilterMessage="Репозитории не найдены" />
              </label>
            </div>
            <div class="filter-actions queue-filter-actions">
              <button pButton type="button" icon="pi pi-sliders-h" severity="secondary" [text]="true"
                [label]="extraFilterCount() ? 'Ещё фильтры (' + extraFilterCount() + ')' : 'Ещё фильтры'"
                [attr.aria-expanded]="showExtraFilters()" aria-controls="queue-extra-filters"
                data-testid="queue-more-filters" (click)="showExtraFilters.set(!showExtraFilters())"></button>
              @if (hasFilters()) {
                <button pButton type="button" data-testid="queue-reset-filters" label="Сбросить" severity="secondary"
                  [text]="true" (click)="resetFilters()"></button>
              }
            </div>
            <div class="queue-filter-main queue-extra-filters" id="queue-extra-filters" [hidden]="!showExtraFilters()">
              <label class="field">
                <span>Очередь</span>
                <input pInputText formControlName="queue" placeholder="Например, DEV" />
              </label>
              <label class="field">
                <span>Приоритет</span>
                <input pInputText formControlName="priority" placeholder="Например, high" />
              </label>
              <label class="field">
                <span>Воркер</span>
                <input pInputText formControlName="worker" placeholder="ID воркера" />
              </label>
              <label class="field">
                <span>Тег</span>
                <input pInputText formControlName="tag" placeholder="Например, ai_dev" />
              </label>
            </div>
          </form>

          <div class="queue-list-toolbar">
            <span class="muted" role="status">
              @if (loading()) {
                Обновляем очередь…
              } @else if (!error() || tasks().length) {
                {{ nextCursor() ? 'Показано задач' : 'Задач' }}: {{ tasks().length }}
              }
            </span>
            <button pButton type="button" data-testid="queue-refresh" icon="pi pi-refresh" label="Обновить"
              severity="secondary" [text]="true" [disabled]="loading()" (click)="loadTasks()"></button>
          </div>
          @if (error(); as message) {
            <p-message severity="error" text="Не удалось обновить очередь. {{ message }}" />
          }
          <div class="queue-groups" [attr.aria-busy]="loading()">
            @if (loading() && !tasks().length) {
              <div class="surface queue-group" aria-hidden="true">
                <p-skeleton width="9rem" height="1rem" />
                <p-skeleton height="3.25rem" />
                <p-skeleton height="3.25rem" />
              </div>
            } @else if (visibleGroups().length === 0 && !error()) {
              <div class="empty-state surface">
                <i class="pi pi-inbox" aria-hidden="true"></i>
                <h2>{{ hasFilters() ? 'Задачи не найдены' : 'Очередь пока пуста' }}</h2>
                @if (hasFilters()) {
                  <p>Измените запрос или сбросьте фильтры.</p>
                }
              </div>
            } @else {
              @for (group of visibleGroups(); track group.status) {
                <section class="surface queue-group">
                  <header class="queue-group__header">
                    <h2><span class="queue-status-dot" [attr.data-severity]="statusSeverity(group.status)" aria-hidden="true"></span>
                      {{ group.status === 'other' ? 'Другое' : statusLabel(group.status) }}</h2>
                    <span class="queue-group-count">{{ group.tasks.length }}</span>
                  </header>
                  <div class="task-row-list">
                    @for (task of group.tasks; track task.id) {
                      <button type="button" class="task-row"
                        [id]="'queue-task-' + task.id"
                        [attr.data-testid]="'task-row-' + task.id"
                        [class.task-row--selected]="task.id === selectedId()"
                        [attr.aria-expanded]="task.id === selectedId()"
                        aria-controls="queue-task-panel"
                        (click)="selectTask(task.id, $event)">
                        <span class="task-row__title">{{ task.title }}</span>
                        <span class="task-row__meta">
                          <span>{{ task.id }}</span>
                          @if (task.repositoryName) { <span>{{ repositories.repoLabel(task.repositoryName) }}</span> }
                          @if (group.status === 'other') {
                            <p-tag [value]="statusLabel(task.status)" [severity]="statusSeverity(task.status)" />
                          }
                          @if (task.priority && task.priority !== 'normal') {
                            <span>{{ priorityLabel(task.priority) }}</span>
                          }
                        </span>
                        @if (task.blockerReason || task.latestValidationSummary) {
                          <span class="task-row__summary">{{ truncate(task.blockerReason || task.latestValidationSummary, 140) }}</span>
                        }
                        <time class="task-row__time" [attr.datetime]="task.updatedAt">{{ formatDate(task.updatedAt) }}</time>
                        <i class="pi pi-chevron-right task-row__chevron" aria-hidden="true"></i>
                      </button>
                    }
                  </div>
                </section>
              }
            }
          </div>
          @if (nextCursor(); as cursor) {
            <div class="action-bar">
              <button pButton type="button" label="Показать ещё" severity="secondary" data-testid="queue-more-tasks"
                [disabled]="loading()" (click)="loadTasks(cursor)"></button>
            </div>
          }
        </div>

        <aside class="queue-right" id="queue-task-panel" aria-label="Детали выбранной задачи">
          @if (selectedId(); as taskId) {
            <div class="queue-detail-actions">
              <button pButton id="queue-back" type="button" icon="pi pi-arrow-left" label="К очереди"
                severity="secondary" [text]="true" data-testid="queue-back" (click)="clearSelection()"></button>
              <a pButton [routerLink]="['/', taskId]" [queryParams]="queueQuery()" icon="pi pi-external-link"
                label="Открыть карточку" severity="secondary" [text]="true" data-testid="queue-open-task"></a>
            </div>
          }
          <app-task-detail-panel [taskId]="selectedId()" (taskChanged)="loadTasks()" />
        </aside>
      </div>
    </section>
  `,
  styles: `
    .queue-page, .queue-left, .queue-right, .queue-filters, .queue-groups {
      display: grid;
      min-width: 0;
      gap: 12px;
    }
    .queue-layout {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
      gap: 20px;
    }
    .queue-right {
      position: sticky;
      top: calc(var(--console-toolbar-height, 60px) + 16px);
      max-height: calc(100dvh - var(--console-toolbar-height, 60px) - 32px);
      overflow: auto;
    }
    .queue-filters { gap: 10px; }
    .queue-filter-main {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .queue-filter-main[hidden] { display: none; }
    .queue-filter-main .field { min-width: 0; }
    .queue-filter-main p-multiselect { min-width: 0; max-width: 100%; }
    .queue-filter-actions { justify-content: space-between; }
    .queue-extra-filters {
      border-top: 1px solid var(--console-border);
      padding-top: 10px;
    }
    .queue-search {
      position: relative;
      display: block;
      font-size: inherit;
      font-weight: 400;
    }
    .queue-search i {
      position: absolute;
      inset-inline-start: 12px;
      top: 50%;
      transform: translateY(-50%);
      pointer-events: none;
    }
    .queue-search input { padding-inline-start: 36px; }
    .queue-list-toolbar, .queue-detail-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 4px 8px;
    }
    .queue-group { min-height: 0; padding: 0; overflow: hidden; }
    .queue-group[aria-hidden='true'] { display: grid; gap: 8px; padding: 14px; }
    .queue-group__header {
      align-items: center;
      padding: 10px 14px;
      border-bottom: 1px solid var(--console-border);
    }
    .queue-group__header h2 {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .queue-group-count { color: var(--console-muted); font-variant-numeric: tabular-nums; }
    .queue-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--console-muted);
      flex: 0 0 auto;
    }
    .queue-status-dot[data-severity='warn'] { background: #a35709; }
    .queue-status-dot[data-severity='danger'] { background: #b42318; }
    .queue-status-dot[data-severity='success'] { background: #087443; }
    .queue-status-dot[data-severity='info'] { background: var(--console-link); }
    .task-row-list { gap: 0; }
    .task-row {
      position: relative;
      min-height: 0;
      gap: 3px;
      border: 0;
      border-radius: 0;
      padding: 10px 34px 10px 14px;
      background: transparent;
    }
    .task-row + .task-row { border-top: 1px solid var(--console-border); }
    .task-row:hover, .task-row--selected { background: var(--console-panel-muted); }
    .task-row--selected { box-shadow: inset 3px 0 var(--console-focus); }
    .task-row:focus-visible {
      outline: 2px solid var(--console-focus);
      outline-offset: -2px;
    }
    .task-row__meta, .task-row__time { color: var(--console-muted); font-size: 0.8rem; }
    .task-row__meta > span, .task-row__summary { overflow-wrap: anywhere; min-width: 0; }
    .task-row__meta > span + span::before { content: '·'; margin-inline-end: 6px; }
    .task-row__chevron {
      position: absolute;
      inset-inline-end: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--console-muted);
      font-size: 0.7rem;
    }
    @media (max-width: 1099px) {
      .queue-layout { grid-template-columns: minmax(0, 1fr); }
      .queue-right { position: static; max-height: none; overflow: visible; }
      .queue-page:not(.queue-page--selected) .queue-right,
      .queue-page--selected .queue-left,
      .queue-page--selected .queue-header { display: none; }
    }
    @media (max-width: 399px) {
      .queue-filter-main { grid-template-columns: minmax(0, 1fr); }
    }
  `,
})
export class QueuePageComponent implements OnInit {
  private readonly taskApi = inject(TaskApiService);
  private readonly session = inject(SessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly location = inject(Location);
  protected readonly repositories = inject(RepositoryDirectoryService);
  private readonly requests = new Subject<TaskListFilters>();
  private lastFilterKey: string | undefined;

  protected readonly limit = 100;
  protected readonly statusOptions = GROUP_ORDER.map((status) => ({
    label: statusLabel(status),
    value: status,
  }));
  protected readonly statusLabel = statusLabel;
  protected readonly statusSeverity = statusSeverity;
  protected readonly priorityLabel = projectGoalPriorityLabel;
  protected readonly formatDate = formatDate;
  protected readonly truncate = truncate;

  protected readonly filters = new FormGroup({
    search: new FormControl('', { nonNullable: true }),
    status: new FormControl<TaskStatusDto[]>([], { nonNullable: true }),
    repository: new FormControl('', { nonNullable: true }),
    queue: new FormControl('', { nonNullable: true }),
    priority: new FormControl('', { nonNullable: true }),
    worker: new FormControl('', { nonNullable: true }),
    tag: new FormControl('', { nonNullable: true }),
  });

  protected readonly queueQuery = signal<Record<string, string | TaskStatusDto[]>>({});
  protected readonly showExtraFilters = signal(false);
  protected readonly extraFilterCount = computed(() =>
    ['queue', 'priority', 'worker', 'tag'].filter((key) => this.queueQuery()[key]).length,
  );
  protected readonly hasFilters = computed(() => Object.keys(this.queueQuery()).length > 0);
  protected readonly tasks = signal<TaskSummaryDto[]>([]);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly nextCursor = signal<string | undefined>(undefined);
  protected readonly repositoryOptions = computed(() => {
    const options = new Map(this.repositories.options().map(({ id, label }) => [id, label]));
    for (const task of this.tasks()) {
      if (task.repositoryName && !options.has(task.repositoryName)) {
        options.set(task.repositoryName, task.repositoryName);
      }
    }
    const selected = this.queueQuery()['repository'];
    if (typeof selected === 'string' && !options.has(selected)) options.set(selected, selected);
    return [
      { id: '', label: 'Все репозитории' },
      ...Array.from(options, ([id, label]) => ({ id, label })),
    ];
  });
  protected readonly visibleGroups = computed<QueueGroup[]>(() =>
    [...GROUP_ORDER, 'other' as const]
      .map((status) => ({
        status,
        tasks: this.tasks().filter((task) =>
          status === 'other' ? !QUEUE_GROUP_STATUSES.includes(task.status) : task.status === status,
        ),
      }))
      .filter((group) => group.tasks.length > 0),
  );

  ngOnInit(): void {
    this.requests
      .pipe(
        switchMap((filters) => this.taskApi.listTasks(filters).pipe(
          map((response) => ({ response, append: !!filters.cursor })),
          catchError((error: unknown) => {
            this.error.set(error instanceof Error ? error.message : String(error));
            this.loading.set(false);
            return EMPTY;
          }),
        )),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ response, append }) => {
        if (append) {
          const merged = new Map(this.tasks().map((task) => [task.id, task]));
          response.tasks.forEach((task) => merged.set(task.id, task));
          this.tasks.set([...merged.values()]);
        } else {
          this.tasks.set(response.tasks);
        }
        this.nextCursor.set(response.nextCursor);
        this.loading.set(false);
      });

    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const textFilter = (key: 'search' | 'repository' | 'queue' | 'priority' | 'worker' | 'tag'): string => {
        const current = this.filters.controls[key].value;
        const fromUrl = params.get(key) ?? '';
        return current.trim() === fromUrl ? current : fromUrl;
      };
      this.filters.setValue({
        search: textFilter('search'),
        status: params.getAll('status')
          .filter((status): status is TaskStatusDto => TASK_STATUSES.includes(status as TaskStatusDto)),
        repository: textFilter('repository'),
        queue: textFilter('queue'),
        priority: textFilter('priority'),
        worker: textFilter('worker'),
        tag: textFilter('tag'),
      }, { emitEvent: false });
      this.queueQuery.set(this.currentQuery());
      const previousSelection = this.selectedId();
      const selection = params.get('selected');
      this.selectedId.set(selection);
      if (previousSelection && !selection) {
        this.focusAfterRender('queue-task-' + previousSelection, 'queue-search');
      }
      const key = JSON.stringify(this.currentFilters());
      if (key !== this.lastFilterKey) {
        this.loadTasks();
      }
    });

    this.filters.valueChanges
      .pipe(debounceTime(250), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.applyFilters());
  }

  protected async selectTask(taskId: string, event: MouseEvent): Promise<void> {
    const narrow = this.isNarrow();
    const addHistoryEntry = narrow && !this.selectedId();
    if (addHistoryEntry && JSON.stringify(this.currentQuery()) !== JSON.stringify(this.queueQuery())) {
      await this.navigateWithFilters(null);
    }
    const navigated = await this.navigateWithFilters(taskId, addHistoryEntry);
    if (!navigated) {
      return;
    }
    this.document.getElementById('queue-task-panel')?.scrollTo({ top: 0 });
    if (event.detail === 0 || narrow) {
      this.focusAfterRender('queue-back');
    }
  }

  protected clearSelection(): void {
    const state = this.location.getState() as { queueOpenedFromList?: boolean } | null;
    if (state?.queueOpenedFromList) {
      this.location.back();
    } else {
      void this.navigateWithFilters(null);
    }
  }

  protected applyFilters(): void {
    void this.navigateWithFilters(this.selectedId());
  }

  protected canCreateTask(): boolean {
    return canUseCapability(this.session.session(), 'canCreateTask');
  }

  protected resetFilters(): void {
    this.filters.setValue(EMPTY_FILTERS, { emitEvent: false });
    this.applyFilters();
    this.document.getElementById('queue-search')?.focus();
  }

  protected loadTasks(cursor?: string): void {
    const filters = this.currentFilters();
    this.lastFilterKey = JSON.stringify(filters);
    if (!cursor) this.nextCursor.set(undefined);
    this.loading.set(true);
    this.error.set(undefined);
    this.requests.next({ ...filters, cursor });
  }

  private currentFilters(): TaskListFilters {
    const value = this.filters.getRawValue();
    return {
      status: [...value.status].sort(),
      search: value.search.trim(),
      repository: value.repository.trim(),
      queue: value.queue.trim(),
      priority: value.priority.trim(),
      worker: value.worker.trim(),
      tag: value.tag.trim(),
      limit: this.limit,
    };
  }

  private currentQuery(): Record<string, string | TaskStatusDto[]> {
    const { status, repository, queue, priority, worker, tag } = this.currentFilters();
    const search = this.filters.controls.search.value.trim();
    return {
      ...(search ? { search } : {}),
      ...(status?.length ? { status } : {}),
      ...(repository ? { repository } : {}),
      ...(queue ? { queue } : {}),
      ...(priority ? { priority } : {}),
      ...(worker ? { worker } : {}),
      ...(tag ? { tag } : {}),
    };
  }

  private navigateWithFilters(selected: string | null, addHistoryEntry = false): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        ...this.currentQuery(),
        ...(selected ? { selected } : {}),
      },
      replaceUrl: !addHistoryEntry,
      ...(addHistoryEntry ? { state: { queueOpenedFromList: true } } : {}),
    });
  }

  private focusAfterRender(id: string, fallback?: string): void {
    this.document.defaultView?.requestAnimationFrame(() => {
      if (this.destroyRef.destroyed) {
        return;
      }
      const target = this.document.getElementById(id) ?? (fallback ? this.document.getElementById(fallback) : null);
      target?.focus();
    });
  }

  private isNarrow(): boolean {
    return this.document.defaultView?.matchMedia('(max-width: 1099px)').matches ?? false;
  }
}
