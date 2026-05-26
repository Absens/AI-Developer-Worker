import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';

import { ProposalSummaryDto } from '../models/human-api.dto';
import { ProposalService } from '../services/proposal.service';
import { SessionService } from '../services/session.service';
import { TaskCommandName, TaskCommandService } from '../services/task-command.service';
import { canUseCapability, formatDate, statusLabel, statusSeverity, truncate } from '../utils/task-ui';

interface PendingProposalAction {
  proposal: ProposalSummaryDto;
  command: Extract<TaskCommandName, 'approve-proposal' | 'reject-proposal'>;
  label: string;
}

@Component({
  selector: 'app-proposals-page',
  imports: [
    ButtonModule,
    CommonModule,
    DialogModule,
    MessageModule,
    ProgressSpinnerModule,
    ReactiveFormsModule,
    RouterLink,
    SelectModule,
    TagModule,
    TextareaModule,
  ],
  template: `
    <section class="page proposals-page" data-testid="proposals-page">
      <header class="page__header">
        <h1>Предложения</h1>
        <p>Проверяйте задачи, предложенные AI, с учетом статуса супервизора, политики и доказательств.</p>
      </header>

      <div class="surface filter-grid filter-grid--compact">
        <label class="field">
          <span>Статус супервизора</span>
          <p-select
            [formControl]="statusFilter"
            [options]="statusOptions"
            optionLabel="label"
            optionValue="value"
            (onChange)="load()"
          />
        </label>
        <div class="filter-actions">
          <button
            pButton
            type="button"
            data-testid="proposals-refresh"
            icon="pi pi-refresh"
            label="Обновить"
            severity="secondary"
            (click)="load()"
          ></button>
        </div>
      </div>

      @if (error(); as message) {
        <p-message severity="error" [text]="message" />
      }

      @if (loading()) {
        <div class="loading-row" aria-live="polite">
          <p-progressSpinner ariaLabel="Загрузка предложений" />
          <span>Загрузка предложений</span>
        </div>
      } @else if (proposals().length === 0) {
        <div class="empty-state surface">
          <i class="pi pi-verified" aria-hidden="true"></i>
          <h2>Предложения не найдены</h2>
          <p>Измените фильтр статуса супервизора или дождитесь новых AI-предложений.</p>
        </div>
      } @else {
        <div class="proposal-list">
          @for (proposal of proposals(); track proposal.id) {
            <article class="surface proposal-row" [attr.data-testid]="'proposal-row-' + proposal.id">
              <div class="proposal-row__main">
                <div class="eyebrow">{{ proposal.id }}</div>
                <h2><a [routerLink]="['/', proposal.id]">{{ proposal.title }}</a></h2>
                <div class="tag-row">
                  <p-tag [value]="proposal.proposal.supervisorStatus" [severity]="proposalSeverity(proposal)" />
                  <p-tag [value]="statusLabel(proposal.status)" [severity]="statusSeverity(proposal.status)" />
                  @if (proposal.repositoryName) {
                    <p-tag [value]="proposal.repositoryName" severity="secondary" />
                  }
                  @if (proposal.proposal.autonomyLevel) {
                    <p-tag [value]="proposal.proposal.autonomyLevel" severity="secondary" />
                  }
                </div>
                @if (proposal.projectGoals?.length) {
                  <div class="summary-block proposal-goals" data-testid="proposal-project-goals">
                    <h3>Цели проекта</h3>
                    <div class="goal-badge-list">
                      @for (goal of proposal.projectGoals; track goal.id) {
                        <a class="goal-badge" [routerLink]="['/goals', goal.id]">
                          <span class="goal-badge__title">{{ goal.title }}</span>
                          <span class="tag-row tag-row--compact">
                            <p-tag [value]="goalStatusLabel(goal.status)" [severity]="goalStatusSeverity(goal.status)" />
                            <p-tag [value]="'Риск: ' + goal.riskLevel" [severity]="riskSeverity(goal.riskLevel)" />
                          </span>
                        </a>
                      }
                    </div>
                  </div>
                }
                @if (proposal.proposal.proposalReason) {
                  <p>{{ truncate(proposal.proposal.proposalReason, 420) }}</p>
                }

                <div class="field-grid field-grid--compact">
                  <div>
                    <span class="field-label">Предложил</span>
                    <span>{{ proposal.proposal.proposedBy || 'Неизвестно' }}</span>
                  </div>
                  <div>
                    <span class="field-label">Решение политики</span>
                    <span>{{ proposal.proposal.policyDecision || 'Неизвестно' }}</span>
                  </div>
                  <div>
                    <span class="field-label">Создано</span>
                    <span>{{ formatDate(proposal.proposal.createdAt) }}</span>
                  </div>
                </div>

                @if (proposal.proposal.policyReason) {
                  <div class="summary-block">
                    <h3>Причина политики</h3>
                    <p>{{ truncate(proposal.proposal.policyReason, 420) }}</p>
                  </div>
                }

                @if (proposal.proposal.suggestedAcceptanceCriteria?.length) {
                  <div class="summary-block">
                    <h3>Предложенные критерии приемки</h3>
                    <ul class="compact-list">
                      @for (criterion of proposal.proposal.suggestedAcceptanceCriteria; track criterion) {
                        <li>{{ criterion }}</li>
                      }
                    </ul>
                  </div>
                }

                @if (proposal.proposal.evidenceRefs?.length) {
                  <div class="evidence-list">
                    @for (evidence of proposal.proposal.evidenceRefs; track evidence.kind + evidence.ref) {
                      <div class="evidence-item">
                        <strong>{{ evidence.kind }}</strong>
                        <span>{{ evidence.ref }}</span>
                        @if (evidence.summary) {
                          <p>{{ truncate(evidence.summary, 220) }}</p>
                        }
                      </div>
                    }
                  </div>
                }
              </div>

              @if (canReview(proposal)) {
                <div class="proposal-row__actions">
                  <button
                    pButton
                    type="button"
                    [attr.data-testid]="'proposal-approve-' + proposal.id"
                    icon="pi pi-check"
                    label="Одобрить"
                    (click)="openAction(proposal, 'approve-proposal')"
                  ></button>
                  <button
                    pButton
                    type="button"
                    [attr.data-testid]="'proposal-reject-' + proposal.id"
                    icon="pi pi-times"
                    label="Отклонить"
                    severity="danger"
                    (click)="openAction(proposal, 'reject-proposal')"
                  ></button>
                </div>
              }
            </article>
          }
        </div>
      }
    </section>

    <p-dialog
      [header]="pendingAction()?.label || 'Проверка предложения'"
      [visible]="dialogVisible()"
      (visibleChange)="dialogVisible.set($event)"
      [modal]="true"
      [style]="{ width: 'min(560px, 94vw)' }"
    >
      <div data-testid="proposal-command-dialog">
      @if (pendingAction(); as action) {
        <div class="stack">
          <p>{{ action.proposal.title }}</p>
          <label class="field">
            <span>Причина <strong aria-label="обязательно">*</strong></span>
            <textarea
              pTextarea
              data-testid="proposal-reason"
              autofocus
              rows="4"
              [formControl]="reasonControl"
              placeholder="Укажите причину проверки"
            ></textarea>
          </label>
          <div class="action-bar action-bar--end">
            <button pButton type="button" data-testid="proposal-cancel" label="Отмена" severity="secondary" (click)="closeDialog()"></button>
            <button
              pButton
              type="button"
              data-testid="proposal-confirm"
              icon="pi pi-check"
              label="Подтвердить"
              [disabled]="reasonControl.invalid || submitting()"
              (click)="submitAction()"
            ></button>
          </div>
        </div>
      }
      </div>
    </p-dialog>
  `,
})
export class ProposalsPageComponent implements OnInit {
  private readonly proposalsApi = inject(ProposalService);
  private readonly commandApi = inject(TaskCommandService);
  private readonly session = inject(SessionService);
  private readonly messages = inject(MessageService);

  protected readonly statusOptions = [
    { label: 'Предложено', value: 'proposed' },
    { label: 'Одобрено', value: 'approved' },
    { label: 'Отклонено', value: 'rejected' },
    { label: 'Все', value: '' },
  ];
  protected readonly statusFilter = new FormControl<string>('proposed', { nonNullable: true });
  protected readonly reasonControl = new FormControl<string>('', {
    nonNullable: true,
    validators: [Validators.required],
  });

  protected readonly proposals = signal<ProposalSummaryDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly dialogVisible = signal(false);
  protected readonly pendingAction = signal<PendingProposalAction | undefined>(undefined);

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(undefined);
    this.proposalsApi.list(this.statusFilter.value || undefined).subscribe({
      next: (response) => {
        this.proposals.set(response.proposals);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.error.set(error instanceof Error ? error.message : String(error));
        this.loading.set(false);
      },
    });
  }

  protected canReview(proposal: ProposalSummaryDto): boolean {
    return (
      proposal.proposal.supervisorStatus === 'proposed' &&
      canUseCapability(this.session.session(), 'canApproveProposal') &&
      canUseCapability(this.session.session(), 'canRejectProposal')
    );
  }

  protected openAction(
    proposal: ProposalSummaryDto,
    command: Extract<TaskCommandName, 'approve-proposal' | 'reject-proposal'>,
  ): void {
    this.pendingAction.set({
      proposal,
      command,
      label: command === 'approve-proposal' ? 'Одобрить предложение' : 'Отклонить предложение',
    });
    this.reasonControl.reset('');
    this.dialogVisible.set(true);
    setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('[data-testid="proposal-reason"]')?.focus();
    });
  }

  protected submitAction(): void {
    const action = this.pendingAction();
    if (!action || this.reasonControl.invalid) {
      this.reasonControl.markAsTouched();
      return;
    }
    this.submitting.set(true);
    this.commandApi
      .run(action.proposal.id, action.command, { reason: this.reasonControl.value.trim() })
      .subscribe({
        next: () => {
          this.messages.add({ severity: 'success', summary: `${action.label}: выполнено.` });
          this.closeDialog();
          this.submitting.set(false);
          this.load();
        },
        error: (error: unknown) => {
          this.messages.add({
            severity: 'error',
            summary: 'Действие с предложением не выполнено',
            detail: error instanceof Error ? error.message : String(error),
          });
          this.submitting.set(false);
        },
      });
  }

  protected closeDialog(): void {
    this.dialogVisible.set(false);
    this.pendingAction.set(undefined);
    this.reasonControl.reset('');
  }

  protected proposalSeverity(proposal: ProposalSummaryDto): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (proposal.proposal.supervisorStatus === 'approved') {
      return 'success';
    }
    if (proposal.proposal.supervisorStatus === 'rejected') {
      return 'danger';
    }
    if (proposal.proposal.supervisorStatus === 'proposed') {
      return 'warn';
    }
    return 'secondary';
  }

  protected statusLabel(status: string): string {
    return statusLabel(status);
  }

  protected statusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' {
    return statusSeverity(status);
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

  protected truncate(value: string | undefined, max?: number): string {
    return truncate(value, max);
  }
}
