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
    <section class="page proposals-page">
      <header class="page__header">
        <h1>Proposals</h1>
        <p>Review AI-proposed tasks using supervisor status, policy context, and evidence refs.</p>
      </header>

      <div class="surface filter-grid filter-grid--compact">
        <label class="field">
          <span>Supervisor status</span>
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
            icon="pi pi-refresh"
            label="Refresh"
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
          <p-progressSpinner ariaLabel="Loading proposals" />
          <span>Loading proposals</span>
        </div>
      } @else if (proposals().length === 0) {
        <div class="empty-state surface">
          <i class="pi pi-verified" aria-hidden="true"></i>
          <h2>No proposals found</h2>
          <p>Change the supervisor-status filter or wait for new AI proposals.</p>
        </div>
      } @else {
        <div class="proposal-list">
          @for (proposal of proposals(); track proposal.id) {
            <article class="surface proposal-row">
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
                @if (proposal.proposal.proposalReason) {
                  <p>{{ truncate(proposal.proposal.proposalReason, 420) }}</p>
                }

                <div class="field-grid field-grid--compact">
                  <div>
                    <span class="field-label">Proposed by</span>
                    <span>{{ proposal.proposal.proposedBy || 'Unknown' }}</span>
                  </div>
                  <div>
                    <span class="field-label">Policy decision</span>
                    <span>{{ proposal.proposal.policyDecision || 'Unknown' }}</span>
                  </div>
                  <div>
                    <span class="field-label">Created</span>
                    <span>{{ formatDate(proposal.proposal.createdAt) }}</span>
                  </div>
                </div>

                @if (proposal.proposal.policyReason) {
                  <div class="summary-block">
                    <h3>Policy Reason</h3>
                    <p>{{ truncate(proposal.proposal.policyReason, 420) }}</p>
                  </div>
                }

                @if (proposal.proposal.suggestedAcceptanceCriteria?.length) {
                  <div class="summary-block">
                    <h3>Suggested Acceptance Criteria</h3>
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
                    icon="pi pi-check"
                    label="Approve"
                    (click)="openAction(proposal, 'approve-proposal')"
                  ></button>
                  <button
                    pButton
                    type="button"
                    icon="pi pi-times"
                    label="Reject"
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
      [header]="pendingAction()?.label || 'Review proposal'"
      [visible]="dialogVisible()"
      (visibleChange)="dialogVisible.set($event)"
      [modal]="true"
      [style]="{ width: 'min(560px, 94vw)' }"
    >
      @if (pendingAction(); as action) {
        <div class="stack">
          <p>{{ action.proposal.title }}</p>
          <label class="field">
            <span>Reason <strong aria-label="required">*</strong></span>
            <textarea
              pTextarea
              rows="4"
              [formControl]="reasonControl"
              placeholder="Record the review reason"
            ></textarea>
          </label>
          <div class="action-bar action-bar--end">
            <button pButton type="button" label="Cancel" severity="secondary" (click)="closeDialog()"></button>
            <button
              pButton
              type="button"
              icon="pi pi-check"
              label="Confirm"
              [disabled]="reasonControl.invalid || submitting()"
              (click)="submitAction()"
            ></button>
          </div>
        </div>
      }
    </p-dialog>
  `,
})
export class ProposalsPageComponent implements OnInit {
  private readonly proposalsApi = inject(ProposalService);
  private readonly commandApi = inject(TaskCommandService);
  private readonly session = inject(SessionService);
  private readonly messages = inject(MessageService);

  protected readonly statusOptions = [
    { label: 'Proposed', value: 'proposed' },
    { label: 'Approved', value: 'approved' },
    { label: 'Rejected', value: 'rejected' },
    { label: 'All', value: '' },
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
      label: command === 'approve-proposal' ? 'Approve proposal' : 'Reject proposal',
    });
    this.reasonControl.reset('');
    this.dialogVisible.set(true);
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
          this.messages.add({ severity: 'success', summary: `${action.label} completed.` });
          this.closeDialog();
          this.submitting.set(false);
          this.load();
        },
        error: (error: unknown) => {
          this.messages.add({
            severity: 'error',
            summary: 'Proposal action failed',
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

  protected formatDate(value: string): string {
    return formatDate(value);
  }

  protected truncate(value: string | undefined, max?: number): string {
    return truncate(value, max);
  }
}
