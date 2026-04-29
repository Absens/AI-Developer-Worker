import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';

import { CreateTaskRequestDto } from '../models/human-api.dto';
import { SessionService } from '../services/session.service';
import { TaskApiService } from '../services/task-api.service';
import { canUseCapability, splitListInput } from '../utils/task-ui';

type TaskType = NonNullable<CreateTaskRequestDto['taskType']>;

interface TemplateOption {
  label: string;
  value: TaskType;
  description: string;
  acceptanceCriteria: string[];
  constraints: string[];
  riskFactors: string[];
}

interface PreviewRow {
  label: string;
  value: string;
}

const tagPattern = /^[A-Za-z0-9_.:-]+$/;

const tagListValidator = (control: AbstractControl<string>): ValidationErrors | null => {
  const invalid = splitListInput(control.value).some((entry) => !tagPattern.test(entry));
  return invalid ? { tagList: true } : null;
};

const listTextValidator = (control: AbstractControl<string>): ValidationErrors | null => {
  const malformed = splitListInput(control.value).some((entry) => entry.length < 3);
  return malformed ? { listText: true } : null;
};

@Component({
  selector: 'app-create-task-page',
  imports: [
    ButtonModule,
    CommonModule,
    DialogModule,
    InputTextModule,
    MessageModule,
    ReactiveFormsModule,
    SelectModule,
    TagModule,
    TextareaModule,
  ],
  template: `
    <section class="page create-page" data-testid="create-page">
      <header class="page__header">
        <h1>Create Task</h1>
        <p>Create a human draft or send a validated task directly to the ready queue.</p>
      </header>

      @if (!canCreateTask()) {
        <p-message data-testid="create-unauthorized" severity="warn" text="Your current session cannot create tasks." />
      }

      @if (error()) {
        <p-message data-testid="create-error" severity="error" [text]="error() || 'Create failed'" />
      }

      <form class="surface create-form" data-testid="create-form" [formGroup]="form" (ngSubmit)="createDraft()">
        <div class="form-section">
          <h2>Template</h2>
          <div class="field-grid">
            <label class="field">
              <span>Task template</span>
              <p-select
                data-testid="create-task-type"
                formControlName="taskType"
                [options]="templates"
                optionLabel="label"
                optionValue="value"
                placeholder="Select template"
                (onChange)="applyTemplate()"
              />
            </label>
            <label class="field">
              <span>Prompt profile</span>
              <input pInputText data-testid="create-prompt-profile" formControlName="promptProfileId" placeholder="frontend_ui_fix" />
            </label>
          </div>
          @if (selectedTemplate(); as template) {
            <p class="muted">{{ template.description }}</p>
          }
        </div>

        <div class="form-section">
          <h2>Task</h2>
          <label class="field">
            <span>Title *</span>
            <input pInputText data-testid="create-title" formControlName="title" placeholder="Short imperative task title" />
            @if (hasError('title')) {
              <small class="error-text">Title is required.</small>
            }
          </label>

          <label class="field">
            <span>Description *</span>
            <textarea
              pTextarea
              data-testid="create-description"
              rows="8"
              formControlName="description"
              placeholder="Describe the requested change, context, and target behavior."
            ></textarea>
            @if (hasError('description')) {
              <small class="error-text">Description is required.</small>
            }
          </label>

          <label class="field">
            <span>Human summary</span>
            <input pInputText data-testid="create-human-summary" formControlName="humanSummary" placeholder="Optional operator summary" />
          </label>
        </div>

        <div class="form-section">
          <h2>Routing</h2>
          <div class="field-grid">
            <label class="field">
              <span>Repository</span>
              <input pInputText data-testid="create-repository" formControlName="repositoryName" placeholder="developer" />
            </label>
            <label class="field">
              <span>Repo path key</span>
              <input pInputText data-testid="create-repo-path-key" formControlName="repoPathKey" placeholder="developer" />
            </label>
            <label class="field">
              <span>Base branch</span>
              <input pInputText data-testid="create-base-branch" formControlName="baseBranch" placeholder="main" />
            </label>
            <label class="field">
              <span>Queue</span>
              <input pInputText data-testid="create-queue" formControlName="queue" placeholder="DEV" />
            </label>
            <label class="field">
              <span>Priority</span>
              <input pInputText data-testid="create-priority" formControlName="priority" placeholder="normal" />
            </label>
          </div>
        </div>

        <div class="form-section">
          <h2>Context</h2>
          <div class="field-grid">
            <label class="field">
              <span>Tags</span>
              <input pInputText data-testid="create-tags" formControlName="tags" placeholder="ai_dev,frontend" />
              @if (hasError('tags')) {
                <small class="error-text">Tags may use letters, numbers, dot, underscore, colon, and dash.</small>
              }
            </label>
            <label class="field">
              <span>Components</span>
              <input pInputText data-testid="create-components" formControlName="components" placeholder="web,api" />
              @if (hasError('components')) {
                <small class="error-text">Components use the same format as tags.</small>
              }
            </label>
          </div>

          <label class="field">
            <span>Acceptance criteria</span>
            <textarea
              pTextarea
              data-testid="create-acceptance"
              rows="5"
              formControlName="acceptanceCriteria"
              placeholder="One criterion per line"
            ></textarea>
            @if (hasError('acceptanceCriteria')) {
              <small class="error-text">Each criterion must contain at least 3 characters.</small>
            }
          </label>

          <div class="field-grid">
            <label class="field">
              <span>Constraints</span>
              <textarea pTextarea data-testid="create-constraints" rows="4" formControlName="constraints" placeholder="One per line"></textarea>
            </label>
            <label class="field">
              <span>Risk factors</span>
              <textarea pTextarea data-testid="create-risk-factors" rows="4" formControlName="riskFactors" placeholder="One per line"></textarea>
            </label>
            <label class="field">
              <span>Missing context</span>
              <textarea pTextarea data-testid="create-missing-context" rows="4" formControlName="missingContext" placeholder="One per line"></textarea>
            </label>
          </div>
        </div>

        <div class="action-bar action-bar--end">
          <button
            pButton
            type="button"
            data-testid="create-preview"
            icon="pi pi-eye"
            label="Preview entered context"
            severity="secondary"
            [disabled]="form.controls.title.invalid || form.controls.description.invalid"
            (click)="openPreview()"
          ></button>
          <button
            pButton
            type="submit"
            data-testid="create-draft"
            icon="pi pi-save"
            label="Save draft"
            severity="secondary"
            [disabled]="submitting() || !canCreateTask()"
          ></button>
          <button
            pButton
            type="button"
            data-testid="create-ready"
            icon="pi pi-check-circle"
            label="Create ready"
            [disabled]="submitting() || !canCreateTask()"
            (click)="createReady()"
          ></button>
        </div>
      </form>
    </section>

    <p-dialog
      header="Entered Context Preview"
      [visible]="previewVisible()"
      (visibleChange)="previewVisible.set($event)"
      [modal]="true"
      [style]="{ width: 'min(760px, 94vw)' }"
      contentStyleClass="dialog-scroll"
    >
      <div data-testid="create-preview-dialog">
      <p class="muted">
        This preview is generated from the current form values. Backend agent context preview is available after task creation.
      </p>
      <div class="preview-grid">
        @for (row of previewRows(); track row.label) {
          <div class="preview-row preview-row--wide">
            <span>{{ row.label }}</span>
            <pre>{{ row.value }}</pre>
          </div>
        }
      </div>
      </div>
    </p-dialog>
  `,
})
export class CreateTaskPageComponent {
  private readonly taskApi = inject(TaskApiService);
  private readonly router = inject(Router);
  private readonly session = inject(SessionService);
  private readonly messages = inject(MessageService);

  protected readonly templates: TemplateOption[] = [
    {
      label: 'Backend endpoint',
      value: 'backend_endpoint',
      description: 'API, handler, validation, authorization, or persistence work.',
      acceptanceCriteria: ['Endpoint success and failure paths are covered.', 'Authorization behavior is verified.'],
      constraints: ['Preserve existing public contracts unless explicitly requested.'],
      riskFactors: ['Backward-incompatible API behavior.', 'Missing validation or authorization.'],
    },
    {
      label: 'Frontend UI fix',
      value: 'frontend_ui_fix',
      description: 'Component, layout, accessibility, or workflow UI work.',
      acceptanceCriteria: ['Affected UI state renders correctly.', 'Responsive and interaction states are verified.'],
      constraints: ['Follow the existing design system and component patterns.'],
      riskFactors: ['Visual regression in adjacent states.', 'Keyboard or focus behavior regressions.'],
    },
    {
      label: 'Tests only',
      value: 'tests_only',
      description: 'Focused tests without production changes unless a real bug is exposed.',
      acceptanceCriteria: ['The intended behavior is covered by tests.', 'Focused and broad test commands pass.'],
      constraints: ['Avoid production changes unless required to make a real failing behavior pass.'],
      riskFactors: ['Brittle assertions tied to implementation details.'],
    },
    {
      label: 'Refactor',
      value: 'refactor',
      description: 'Structure-preserving cleanup or extraction.',
      acceptanceCriteria: ['Behavior is preserved.', 'Relevant checks pass after the refactor.'],
      constraints: ['Keep churn scoped to the requested subsystem.'],
      riskFactors: ['Behavior drift hidden by structural changes.'],
    },
    {
      label: 'Dependency update',
      value: 'dependency_update',
      description: 'Dependency manifest and lockfile updates.',
      acceptanceCriteria: ['Manifest and lockfile are consistent.', 'Build and tests pass with updated dependencies.'],
      constraints: ['Keep unrelated dependency churn out of the change.'],
      riskFactors: ['Transitive dependency breakage.', 'Runtime compatibility changes.'],
    },
    {
      label: 'Documentation',
      value: 'documentation',
      description: 'Readme, runbook, or usage documentation.',
      acceptanceCriteria: ['Commands and configuration names match the repository.', 'Docs are concise and actionable.'],
      constraints: ['Avoid runtime code changes unless required to verify documentation.'],
      riskFactors: ['Stale command examples.', 'Docs diverging from code behavior.'],
    },
  ];

  protected readonly form = new FormGroup({
    taskType: new FormControl<TaskType>('backend_endpoint', { nonNullable: true }),
    promptProfileId: new FormControl('backend_endpoint', { nonNullable: true }),
    title: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    description: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    humanSummary: new FormControl('', { nonNullable: true }),
    repositoryName: new FormControl('developer', { nonNullable: true }),
    repoPathKey: new FormControl('developer', { nonNullable: true }),
    baseBranch: new FormControl('main', { nonNullable: true }),
    queue: new FormControl('DEV', { nonNullable: true }),
    priority: new FormControl('normal', { nonNullable: true }),
    tags: new FormControl('ai_dev', { nonNullable: true, validators: [tagListValidator] }),
    components: new FormControl('', { nonNullable: true, validators: [tagListValidator] }),
    acceptanceCriteria: new FormControl('', { nonNullable: true, validators: [listTextValidator] }),
    constraints: new FormControl('', { nonNullable: true, validators: [listTextValidator] }),
    riskFactors: new FormControl('', { nonNullable: true, validators: [listTextValidator] }),
    missingContext: new FormControl('', { nonNullable: true, validators: [listTextValidator] }),
  });

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly previewVisible = signal(false);
  protected readonly previewRows = signal<PreviewRow[]>([]);
  protected readonly selectedTemplate = signal<TemplateOption | undefined>(undefined);

  constructor() {
    this.applyTemplate();
  }

  protected canCreateTask(): boolean {
    return canUseCapability(this.session.session(), 'canCreateTask');
  }

  protected applyTemplate(): void {
    const template = this.templates.find((entry) => entry.value === this.form.controls.taskType.value);
    if (!template) {
      return;
    }
    this.selectedTemplate.set(template);
    this.form.patchValue({
      promptProfileId: template.value,
      acceptanceCriteria: template.acceptanceCriteria.join('\n'),
      constraints: template.constraints.join('\n'),
      riskFactors: template.riskFactors.join('\n'),
    });
  }

  protected hasError(controlName: keyof CreateTaskPageComponent['form']['controls']): boolean {
    const control = this.form.controls[controlName];
    return control.invalid && (control.dirty || control.touched);
  }

  protected createDraft(): void {
    this.submit(undefined);
  }

  protected createReady(): void {
    this.submit('ready');
  }

  protected openPreview(): void {
    if (this.form.controls.title.invalid || this.form.controls.description.invalid) {
      this.form.controls.title.markAsTouched();
      this.form.controls.description.markAsTouched();
      return;
    }
    const payload = this.buildPayload();
    this.previewRows.set([
      { label: 'Title', value: payload.title },
      { label: 'Description', value: payload.description },
      { label: 'Repository', value: payload.repositoryName || 'Unassigned' },
      { label: 'Queue', value: payload.queue || 'Unassigned' },
      { label: 'Task Type', value: payload.taskType || 'Unspecified' },
      { label: 'Tags', value: payload.tags?.join('\n') || 'None' },
      { label: 'Acceptance Criteria', value: payload.acceptanceCriteria?.join('\n') || 'None' },
      { label: 'Constraints', value: payload.constraints?.join('\n') || 'None' },
      { label: 'Risk Factors', value: payload.riskFactors?.join('\n') || 'None' },
      { label: 'Missing Context', value: payload.missingContext?.join('\n') || 'None' },
    ]);
    this.previewVisible.set(true);
  }

  private submit(status: CreateTaskRequestDto['status'] | undefined): void {
    if (!this.canCreateTask()) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.error.set(undefined);
    this.submitting.set(true);
    this.taskApi.createTask({ ...this.buildPayload(), ...(status ? { status } : {}) }).subscribe({
      next: (response) => {
        this.messages.add({
          severity: 'success',
          summary: status === 'ready' ? 'Ready task created' : 'Draft task created',
        });
        this.router.navigate(['/', response.task.id]);
      },
      error: (error: unknown) => {
        this.error.set(error instanceof Error ? error.message : String(error));
        this.submitting.set(false);
      },
    });
  }

  private buildPayload(): CreateTaskRequestDto {
    const value = this.form.getRawValue();
    const optional = (entry: string): string | undefined => {
      const trimmed = entry.trim();
      return trimmed || undefined;
    };
    return {
      title: value.title.trim(),
      description: value.description.trim(),
      ...(optional(value.humanSummary) ? { humanSummary: optional(value.humanSummary) } : {}),
      ...(optional(value.repositoryName) ? { repositoryName: optional(value.repositoryName) } : {}),
      ...(optional(value.repoPathKey) ? { repoPathKey: optional(value.repoPathKey) } : {}),
      ...(optional(value.baseBranch) ? { baseBranch: optional(value.baseBranch) } : {}),
      ...(optional(value.queue) ? { queue: optional(value.queue) } : {}),
      ...(optional(value.priority) ? { priority: optional(value.priority) } : {}),
      tags: splitListInput(value.tags),
      components: splitListInput(value.components),
      acceptanceCriteria: splitListInput(value.acceptanceCriteria),
      constraints: splitListInput(value.constraints),
      riskFactors: splitListInput(value.riskFactors),
      missingContext: splitListInput(value.missingContext),
      taskType: value.taskType,
      promptProfileId: value.promptProfileId.trim() || value.taskType,
    };
  }
}
