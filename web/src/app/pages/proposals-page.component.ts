import { CommonModule, DOCUMENT } from '@angular/common';
import { Component, DestroyRef, Injector, OnInit, afterNextRender, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { Subscription } from 'rxjs';

import { ProposalSummaryDto } from '../models/human-api.dto';
import { ProposalService } from '../services/proposal.service';
import { RepositoryDirectoryService } from '../services/repository-directory.service';
import { SessionService } from '../services/session.service';
import { TaskCommandName, TaskCommandService } from '../services/task-command.service';
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
    InputTextModule,
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
        <div>
          <h1>Предложения</h1>
          <p>Рассмотрите предложенные задачи перед передачей в очередь.</p>
        </div>
      </header>

      <div class="surface filter-grid filter-grid--compact proposal-filters">
        <label class="field" for="proposal-status">
          <span id="proposal-status-label">Статус проверки</span>
          <p-select
            inputId="proposal-status"
            data-testid="proposals-status"
            ariaLabelledBy="proposal-status-label"
            [formControl]="statusFilter"
            [options]="statusOptions"
            optionLabel="label"
            optionValue="value"
            (onChange)="load()"
          />
        </label>
        <label class="field" for="proposals-repository">
          <span id="proposals-repository-label">Репозиторий</span>
          @if (repositoryOptions().length) {
            <p-select
              inputId="proposals-repository"
              data-testid="proposals-repository"
              ariaLabelledBy="proposals-repository-label"
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
            <input pInputText id="proposals-repository" type="text" data-testid="proposals-repository"
              [formControl]="repositoryFilter" placeholder="Все репозитории" (keyup.enter)="load()" />
          }
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
      } @else if (!error() && proposals().length === 0) {
        <div class="empty-state surface">
          <i class="pi pi-verified" aria-hidden="true"></i>
          <h2>Предложения не найдены</h2>
          <p>Измените репозиторий или статус проверки.</p>
        </div>
      } @else if (proposals().length) {
        <div class="proposal-list">
          @for (proposal of proposals(); track proposal.id) {
            <article class="surface proposal-row" [attr.data-testid]="'proposal-row-' + proposal.id">
              <header class="proposal-header">
                <div class="proposal-heading">
                  <h2><a [id]="'proposal-link-' + proposal.id" [routerLink]="['/', proposal.id]" [queryParams]="proposalContext()">{{ proposal.title }}</a></h2>
                  <div class="tag-row">
                    <p-tag [value]="proposalStatusLabel(proposal.proposal.supervisorStatus)" [severity]="proposalSeverity(proposal)" />
                    <p-tag [value]="statusLabel(proposal.status)" [severity]="statusSeverity(proposal.status)" />
                    @if (proposal.repositoryName) {
                      <p-tag [value]="directory.repoLabel(proposal.repositoryName)" severity="secondary" />
                    }
                  </div>
                </div>
                @if (canReview(proposal)) {
                  <div class="proposal-row__actions">
                    <button
                      pButton
                      type="button"
                      [attr.data-testid]="'proposal-approve-' + proposal.id"
                      size="small"
                      icon="pi pi-check"
                      label="Одобрить"
                      (click)="openAction(proposal, 'approve-proposal')"
                    ></button>
                    <button
                      pButton
                      type="button"
                      [attr.data-testid]="'proposal-reject-' + proposal.id"
                      size="small"
                      icon="pi pi-times"
                      label="Отклонить"
                      severity="danger"
                      [outlined]="true"
                      (click)="openAction(proposal, 'reject-proposal')"
                    ></button>
                  </div>
                }
              </header>

              <div class="proposal-row__main">
                @if (proposal.proposal.proposalReason) {
                  <p class="proposal-reason">{{ truncate(proposal.proposal.proposalReason, 420) }}</p>
                }
                @if (proposal.projectGoals?.length) {
                  <div class="summary-block proposal-goals" data-testid="proposal-project-goals">
                    <h3>Цели проекта</h3>
                    <div class="goal-badge-list">
                      @for (goal of proposal.projectGoals; track goal.id) {
                        <a class="goal-badge" [routerLink]="['/goals', goal.id]" [queryParams]="proposalContext(proposal.id)">
                          <span class="goal-badge__title">{{ goal.title }}</span>
                          @if (goal.desiredOutcome) {
                            <span>{{ truncate(goal.desiredOutcome, 220) }}</span>
                          }
                          <span class="tag-row tag-row--compact">
                            <p-tag [value]="goalStatusLabel(goal.status)" [severity]="goalStatusSeverity(goal.status)" />
                            <p-tag [value]="'Приоритет: ' + priorityLabel(goal.priority)" [severity]="prioritySeverity(goal.priority)" />
                            <p-tag [value]="'Риск: ' + riskLabel(goal.riskLevel)" [severity]="riskSeverity(goal.riskLevel)" />
                          </span>
                        </a>
                      }
                    </div>
                  </div>
                }
                <details class="proposal-details">
                  <summary>Критерии, политика и основания</summary>
                  <div class="proposal-facts">
                    <div class="field-grid field-grid--compact">
                      <div>
                        <span class="field-label">Предложил</span>
                        <span>{{ proposal.proposal.proposedBy || 'Неизвестно' }}</span>
                      </div>
                      <div>
                        <span class="field-label">ID задачи</span>
                        <span>{{ proposal.id }}</span>
                      </div>
                      <div>
                        <span class="field-label">Решение политики</span>
                        <span>{{ proposal.proposal.policyDecision || 'Неизвестно' }}</span>
                      </div>
                      <div>
                        <span class="field-label">Создано</span>
                        <span>{{ formatDate(proposal.proposal.createdAt) }}</span>
                      </div>
                      @if (proposal.proposal.autonomyLevel) {
                        <div>
                          <span class="field-label">Режим автономности</span>
                          <span>{{ proposal.proposal.autonomyLevel }}</span>
                        </div>
                      }
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
                </details>
              </div>
            </article>
          }
        </div>
      }
    </section>

    <p-dialog
      [header]="pendingAction()?.label || 'Проверка предложения'"
      closeAriaLabel="Закрыть проверку"
      [draggable]="false"
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
  styles: [`
    .proposal-filters { max-width: 820px; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto; }
    .proposal-filters .field { min-width: 0; }
    .proposal-list { display: grid; gap: 12px; }
    .proposal-row { display: grid; gap: 14px; min-width: 0; overflow-wrap: anywhere; }
    .proposal-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
      gap: 12px;
    }
    .proposal-heading { display: grid; gap: 6px; }
    .proposal-heading h2 { font-size: 1.125rem; }
    .proposal-heading h2 a { color: var(--console-link); }
    .proposal-row__actions { flex-flow: row wrap; min-width: 0; }
    .proposal-reason { font-size: .9375rem; }
    .proposal-goals {
      border-inline-start: 2px solid var(--console-border);
      padding-inline-start: 12px;
    }
    .proposal-goals h3 { font-size: .875rem; }
    .proposal-goals .goal-badge { padding: 8px 10px; }
    .proposal-details { border-top: 1px solid var(--console-border); padding-top: 8px; }
    .proposal-details summary { cursor: pointer; color: var(--console-link); min-height: 32px; align-content: center; }
    .proposal-facts { display: grid; gap: 12px; margin-top: 8px; }
    .proposal-facts .evidence-list { grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); }
    @media (max-width: 760px) {
      .proposal-header, .proposal-filters { grid-template-columns: minmax(0, 1fr); }
    }
  `],
})
export class ProposalsPageComponent implements OnInit {
  private readonly proposalsApi = inject(ProposalService);
  private readonly commandApi = inject(TaskCommandService);
  private readonly session = inject(SessionService);
  private readonly messages = inject(MessageService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  protected readonly directory = inject(RepositoryDirectoryService);
  private listRequest?: Subscription;
  private pendingFocus?: string;
  private initialized = false;

  protected readonly statusOptions = [
    { label: 'Предложено', value: 'proposed' },
    { label: 'Одобрено', value: 'approved' },
    { label: 'Отклонено', value: 'rejected' },
    { label: 'Все', value: '' },
  ];
  protected readonly statusFilter = new FormControl<string>('proposed', { nonNullable: true });
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
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroy)).subscribe((params) => {
      const requestedStatus = params.get('supervisorStatus');
      const status = requestedStatus === 'all' ? '' :
        this.statusOptions.find((option) => option.value === requestedStatus)?.value ?? 'proposed';
      const repository = params.get('repositoryName')?.trim() ?? '';
      this.pendingFocus = params.get('focus') || undefined;
      const changed = !this.initialized || this.statusFilter.value !== status || this.repositoryFilter.value !== repository;
      this.initialized = true;
      if (changed) {
        this.statusFilter.setValue(status);
        this.repositoryFilter.setValue(repository);
        this.load(false);
      } else if (!this.loading()) {
        this.restoreFocus();
      }
    });
  }

  protected load(updateUrl = true): void {
    const repository = this.repositoryFilter.value.trim();
    if (this.repositoryFilter.value !== repository) this.repositoryFilter.setValue(repository);
    const filters = this.filterParams();
    if (updateUrl) void this.router.navigate([], {
      relativeTo: this.route, queryParams: filters, replaceUrl: true,
    });
    this.listRequest?.unsubscribe();
    this.loading.set(true);
    this.error.set(undefined);
    this.listRequest = this.proposalsApi
      .list(this.statusFilter.value || undefined, repository || undefined)
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (response) => {
          this.proposals.set(response.proposals);
          this.loading.set(false);
          this.restoreFocus();
        },
        error: (error: unknown) => {
          this.error.set(error instanceof Error ? error.message : String(error));
          this.proposals.set([]);
          this.loading.set(false);
          this.restoreFocus();
        },
      });
  }

  protected proposalContext(proposalId?: string): Params {
    return { ...this.filterParams(), from: 'proposals', ...(proposalId ? { proposal: proposalId } : {}) };
  }

  private filterParams(): Params {
    const status = this.statusFilter.value;
    const repository = this.repositoryFilter.value.trim();
    return {
      ...(status !== 'proposed' ? { supervisorStatus: status || 'all' } : {}),
      ...(repository ? { repositoryName: repository } : {}),
    };
  }

  private restoreFocus(): void {
    const id = this.pendingFocus;
    if (!id) return;
    this.pendingFocus = undefined;
    afterNextRender(() => {
      (this.document.getElementById('proposal-link-' + id) ??
        this.document.getElementById('proposal-status'))?.focus();
    }, { injector: this.injector });
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

  protected proposalStatusLabel(status: string): string {
    const option = this.statusOptions.find((item) => item.value === status);
    return option?.label ?? status;
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

  protected formatDate(value: string): string {
    return formatDate(value);
  }

  protected truncate(value: string | undefined, max?: number): string {
    return truncate(value, max);
  }
}
