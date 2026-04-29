import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { debounceTime } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { MultiSelectModule } from 'primeng/multiselect';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';

import { TaskDetailPanelComponent } from '../components/task-detail-panel.component';
import { TaskStatusDto, TaskSummaryDto } from '../models/human-api.dto';
import { TaskApiService, TaskListFilters } from '../services/task-api.service';
import {
  QUEUE_GROUP_STATUSES,
  TASK_STATUSES,
  formatDate,
  statusLabel,
  statusSeverity,
  truncate,
} from '../utils/task-ui';

interface QueueGroup {
  status: TaskStatusDto | 'other';
  label: string;
  tasks: TaskSummaryDto[];
}

@Component({
  selector: 'app-queue-page',
  imports: [
    ButtonModule,
    CommonModule,
    InputTextModule,
    MessageModule,
    MultiSelectModule,
    ReactiveFormsModule,
    RouterLink,
    SkeletonModule,
    TagModule,
    TaskDetailPanelComponent,
  ],
  template: `
    <section class="page queue-page">
      <header class="page__header">
        <div>
          <h1>Queue</h1>
          <p>Tasks grouped by operational state. Filters and selection are encoded in the URL.</p>
        </div>
        <a pButton routerLink="/new" icon="pi pi-plus-circle" label="Create task"></a>
      </header>

      <div class="queue-layout">
        <div class="queue-left">
          <form class="surface filter-grid" [formGroup]="filters" aria-label="Task filters">
            <label class="field">
              <span>Status</span>
              <p-multiselect
                formControlName="status"
                [options]="statusOptions"
                optionLabel="label"
                optionValue="value"
                placeholder="Any status"
                display="chip"
                [showClear]="true"
              />
            </label>
            <label class="field">
              <span>Repository</span>
              <input pInputText formControlName="repository" placeholder="developer" />
            </label>
            <label class="field">
              <span>Queue</span>
              <input pInputText formControlName="queue" placeholder="DEV" />
            </label>
            <label class="field">
              <span>Priority</span>
              <input pInputText formControlName="priority" placeholder="normal" />
            </label>
            <label class="field">
              <span>Worker</span>
              <input pInputText formControlName="worker" placeholder="worker-1" />
            </label>
            <label class="field">
              <span>Tag</span>
              <input pInputText formControlName="tag" placeholder="ai_dev" />
            </label>
            <div class="filter-actions">
              <button
                pButton
                type="button"
                icon="pi pi-filter-slash"
                label="Reset"
                severity="secondary"
                (click)="resetFilters()"
              ></button>
              <button
                pButton
                type="button"
                icon="pi pi-refresh"
                label="Refresh"
                severity="secondary"
                (click)="loadTasks()"
              ></button>
            </div>
          </form>

          @if (error(); as message) {
            <p-message severity="error" [text]="message" />
          }

          @if (resultLimited()) {
            <p-message
              severity="warn"
              text="Showing the first 100 results. Add filters to narrow the queue."
            />
          }

          <div class="queue-groups">
            @if (loading()) {
              @for (placeholder of placeholders; track placeholder) {
                <div class="surface queue-group">
                  <p-skeleton width="12rem" height="1.4rem" />
                  <p-skeleton height="4.2rem" />
                  <p-skeleton height="4.2rem" />
                </div>
              }
            } @else if (tasks().length === 0) {
              <div class="empty-state surface">
                <i class="pi pi-inbox" aria-hidden="true"></i>
                <h2>No tasks match the filters</h2>
                <p>Clear filters or create a new task to populate this queue.</p>
              </div>
            } @else {
              @for (group of groups(); track group.status) {
                <section class="surface queue-group">
                  <header class="queue-group__header">
                    <h2>{{ group.label }}</h2>
                    <p-tag [value]="String(group.tasks.length)" severity="secondary" />
                  </header>

                  @if (group.tasks.length === 0) {
                    <p class="muted">No tasks in this group.</p>
                  } @else {
                    <div class="task-row-list">
                      @for (task of group.tasks; track task.id) {
                        <button
                          type="button"
                          class="task-row"
                          [class.task-row--selected]="task.id === selectedId()"
                          (click)="selectTask(task.id)"
                        >
                          <span class="task-row__title">{{ task.title }}</span>
                          <span class="task-row__meta">
                            <p-tag [value]="statusLabel(task.status)" [severity]="statusSeverity(task.status)" />
                            <span>{{ task.repositoryName || 'unassigned' }}</span>
                            @if (task.queue) {
                              <span>{{ task.queue }}</span>
                            }
                            @if (task.priority) {
                              <span>{{ task.priority }}</span>
                            }
                          </span>
                          @if (task.blockerReason || task.latestValidationSummary || task.latestAiSummary) {
                            <span class="task-row__summary">
                              {{ truncate(task.blockerReason || task.latestValidationSummary || task.latestAiSummary, 180) }}
                            </span>
                          }
                          <span class="task-row__footer">
                            @if (task.activeWorker) {
                              <span><i class="pi pi-user" aria-hidden="true"></i> {{ task.activeWorker }}</span>
                            }
                            @if (task.mergeRequestUrl) {
                              <span><i class="pi pi-code" aria-hidden="true"></i> MR</span>
                            }
                            <span>{{ formatDate(task.updatedAt) }}</span>
                          </span>
                        </button>
                      }
                    </div>
                  }
                </section>
              }
            }
          </div>
        </div>

        <aside class="queue-right" aria-label="Selected task detail">
          <app-task-detail-panel
            [taskId]="selectedId()"
            (taskChanged)="loadTasks()"
          />
        </aside>
      </div>
    </section>
  `,
})
export class QueuePageComponent implements OnInit {
  private readonly taskApi = inject(TaskApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly limit = 100;
  protected readonly placeholders = [1, 2, 3, 4, 5];
  protected readonly statusOptions = TASK_STATUSES.map((status) => ({
    label: statusLabel(status),
    value: status,
  }));

  protected readonly filters = new FormGroup({
    status: new FormControl<TaskStatusDto[]>([], { nonNullable: true }),
    repository: new FormControl('', { nonNullable: true }),
    queue: new FormControl('', { nonNullable: true }),
    priority: new FormControl('', { nonNullable: true }),
    worker: new FormControl('', { nonNullable: true }),
    tag: new FormControl('', { nonNullable: true }),
  });

  protected readonly tasks = signal<TaskSummaryDto[]>([]);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly resultLimited = computed(() => this.tasks().length >= this.limit);
  protected readonly groups = computed<QueueGroup[]>(() => {
    const tasks = this.tasks();
    const knownGroups = QUEUE_GROUP_STATUSES.map((status) => ({
      status,
      label: statusLabel(status),
      tasks: tasks.filter((task) => task.status === status),
    }));
    const other = tasks.filter((task) => !QUEUE_GROUP_STATUSES.includes(task.status));
    return other.length
      ? [...knownGroups, { status: 'other', label: 'Other', tasks: other }]
      : knownGroups;
  });

  private applyingUrl = false;

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.applyingUrl = true;
      this.filters.setValue(
        {
          status: params
            .getAll('status')
            .filter((status): status is TaskStatusDto => TASK_STATUSES.includes(status as TaskStatusDto)),
          repository: params.get('repository') ?? '',
          queue: params.get('queue') ?? '',
          priority: params.get('priority') ?? '',
          worker: params.get('worker') ?? '',
          tag: params.get('tag') ?? '',
        },
        { emitEvent: false },
      );
      this.selectedId.set(params.get('selected'));
      this.applyingUrl = false;
      this.loadTasks();
    });

    this.filters.valueChanges
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (!this.applyingUrl) {
          this.navigateWithFilters(this.selectedId());
        }
      });
  }

  protected selectTask(taskId: string): void {
    this.navigateWithFilters(taskId);
  }

  protected resetFilters(): void {
    this.filters.setValue({
      status: [],
      repository: '',
      queue: '',
      priority: '',
      worker: '',
      tag: '',
    });
  }

  protected loadTasks(): void {
    this.loading.set(true);
    this.error.set(undefined);
    this.taskApi.listTasks(this.currentFilters()).subscribe({
      next: (response) => {
        this.tasks.set(response.tasks);
        this.loading.set(false);
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

  protected formatDate(value: string): string {
    return formatDate(value);
  }

  protected truncate(value: string | undefined, max?: number): string {
    return truncate(value, max);
  }

  protected readonly String = String;

  private currentFilters(): TaskListFilters {
    const value = this.filters.getRawValue();
    return {
      status: value.status,
      repository: value.repository.trim(),
      queue: value.queue.trim(),
      priority: value.priority.trim(),
      worker: value.worker.trim(),
      tag: value.tag.trim(),
      limit: this.limit,
    };
  }

  private navigateWithFilters(selected: string | null): void {
    const filters = this.currentFilters();
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        ...(filters.status?.length ? { status: filters.status } : {}),
        ...(filters.repository ? { repository: filters.repository } : {}),
        ...(filters.queue ? { queue: filters.queue } : {}),
        ...(filters.priority ? { priority: filters.priority } : {}),
        ...(filters.worker ? { worker: filters.worker } : {}),
        ...(filters.tag ? { tag: filters.tag } : {}),
        ...(selected ? { selected } : {}),
      },
      replaceUrl: true,
    });
  }
}
