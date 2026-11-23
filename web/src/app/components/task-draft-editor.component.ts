import { Component, ElementRef, OnInit, inject, input, output } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, ValidatorFn } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { TextareaModule } from 'primeng/textarea';

export interface TaskDraftEditorValue {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

const requiredText: ValidatorFn = (control) => String(control.value).trim() ? null : { required: true };

@Component({
  selector: 'app-task-draft-editor',
  imports: [ButtonModule, DialogModule, InputTextModule, MessageModule, ReactiveFormsModule, TextareaModule],
  template: `
    <p-dialog
      header="Редактировать черновик"
      [visible]="true"
      (visibleChange)="!$event && cancel.emit()"
      [modal]="true"
      [draggable]="false"
      [closable]="!saving()"
      [closeOnEscape]="!saving()"
      [style]="{ width: 'min(640px, 94vw)' }"
    >
      <form class="draft-form" [formGroup]="form" (ngSubmit)="submit()" data-testid="draft-editor">
        @if (stale()) {
          <p-message severity="warn"
            text="Задача уже изменилась. Скопируйте свои правки и откройте актуальный черновик."
            data-testid="draft-stale" />
        } @else if (error(); as message) {
          <p-message severity="error" [text]="message" data-testid="draft-error" />
        }

        <label class="field" for="draft-title">
          <span>Название *</span>
          <input pInputText id="draft-title" data-testid="draft-title" formControlName="title" autofocus
            [attr.aria-invalid]="showError('title') || null" aria-required="true" />
          @if (showError('title')) {
            <small class="error-text">Укажите название.</small>
          }
        </label>
        <label class="field" for="draft-description">
          <span>Описание *</span>
          <textarea pTextarea id="draft-description" data-testid="draft-description" formControlName="description"
            rows="5" [attr.aria-invalid]="showError('description') || null" aria-required="true"></textarea>
          @if (showError('description')) {
            <small class="error-text">Укажите описание.</small>
          }
        </label>
        <label class="field" for="draft-criteria">
          <span>Критерии приёмки</span>
          <textarea pTextarea id="draft-criteria" data-testid="draft-criteria" formControlName="acceptanceCriteria"
            rows="4" aria-describedby="draft-criteria-hint"></textarea>
          <small id="draft-criteria-hint" class="muted">По одному критерию на строку.</small>
        </label>

        <div class="action-bar action-bar--end">
          <button pButton type="button" label="Закрыть" severity="secondary" [disabled]="saving()"
            (click)="cancel.emit()"></button>
          <button pButton type="submit" [label]="saving() ? 'Сохраняем…' : 'Сохранить изменения'"
            [disabled]="saving() || stale()" data-testid="draft-save"></button>
        </div>
      </form>
    </p-dialog>
  `,
  styles: `
    .draft-form { display: grid; gap: 16px; }
    .draft-form textarea { resize: vertical; min-height: 72px; }
    .draft-form .field { min-width: 0; }
  `,
})
export class TaskDraftEditorComponent implements OnInit {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly initial = input.required<TaskDraftEditorValue>();
  readonly saving = input(false);
  readonly stale = input(false);
  readonly error = input<string | undefined>();
  readonly save = output<TaskDraftEditorValue>();
  readonly cancel = output<void>();

  protected readonly form = new FormGroup({
    title: new FormControl('', { nonNullable: true, validators: [requiredText] }),
    description: new FormControl('', { nonNullable: true, validators: [requiredText] }),
    acceptanceCriteria: new FormControl('', { nonNullable: true }),
  });

  ngOnInit(): void {
    const initial = this.initial();
    this.form.setValue({
      title: initial.title,
      description: initial.description,
      acceptanceCriteria: initial.acceptanceCriteria.join('\n'),
    });
  }

  protected showError(field: 'title' | 'description'): boolean {
    const control = this.form.controls[field];
    return control.invalid && control.touched;
  }

  protected submit(): void {
    if (this.saving() || this.stale()) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      const field = this.form.controls.title.invalid ? '#draft-title' : '#draft-description';
      this.host.nativeElement.querySelector<HTMLElement>(field)?.focus();
      return;
    }
    const { title, description, acceptanceCriteria } = this.form.getRawValue();
    this.save.emit({
      title: title.trim(),
      description: description.trim(),
      acceptanceCriteria: acceptanceCriteria.split(/\r?\n/).map((criterion) => criterion.trim()).filter(Boolean),
    });
  }
}
