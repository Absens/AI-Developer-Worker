import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { TaskDetailPanelComponent } from '../components/task-detail-panel.component';

@Component({
  selector: 'app-task-detail-page',
  imports: [RouterLink, TaskDetailPanelComponent],
  template: `
    <section class="page">
      @if (returnTarget(); as target) {
        <a class="queue-return" [routerLink]="target.route" [queryParams]="target.params" [attr.data-testid]="target.testId">
          <i class="pi pi-arrow-left" aria-hidden="true"></i> {{ target.label }}
        </a>
      }
      <app-task-detail-panel [taskId]="taskId()" [fullPage]="true" />
    </section>
  `,
  styles: `
    .queue-return {
      color: var(--console-link);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      justify-self: start;
      min-height: 36px;
      font-weight: 600;
      text-decoration: none;
    }
    .queue-return:hover { text-decoration: underline; }
  `,
})
export class TaskDetailPageComponent {
  private readonly route = inject(ActivatedRoute);
  protected readonly taskId = toSignal(this.route.paramMap.pipe(map((params) => params.get('taskId') ?? '')), {
    initialValue: '',
  });
  private readonly query = toSignal(this.route.queryParams, { initialValue: this.route.snapshot.queryParams });
  protected readonly returnTarget = computed(() => {
    const query = this.query();
    const goal = typeof query['returnGoal'] === 'string' ? query['returnGoal'] : undefined;
    if (goal) {
      const fromProposals = query['from'] === 'proposals';
      return {
        route: ['/goals', goal],
        label: 'К цели',
        testId: 'task-back-to-goal',
        params: {
          repositoryName: query['repositoryName'],
          ...(fromProposals
            ? { from: 'proposals', proposal: query['proposal'], supervisorStatus: query['supervisorStatus'] }
            : { status: query['status'] }),
          focusTask: this.taskId(),
        },
      };
    }
    if (query['from'] === 'proposals') {
      return {
        route: ['/proposals'],
        label: 'К предложениям',
        testId: 'task-back-to-proposals',
        params: {
          repositoryName: query['repositoryName'],
          supervisorStatus: query['supervisorStatus'],
          focus: query['proposal'] || this.taskId(),
        },
      };
    }
    return { route: ['/'], label: 'К очереди', testId: 'task-back-to-queue', params: query };
  });
}
