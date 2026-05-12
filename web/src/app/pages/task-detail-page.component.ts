import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import { TaskDetailPanelComponent } from '../components/task-detail-panel.component';

@Component({
  selector: 'app-task-detail-page',
  imports: [TaskDetailPanelComponent],
  template: `
    <section class="page">
      <app-task-detail-panel [taskId]="taskId()" [fullPage]="true" />
    </section>
  `,
})
export class TaskDetailPageComponent {
  private readonly route = inject(ActivatedRoute);
  protected readonly taskId = toSignal(this.route.paramMap.pipe(map((params) => params.get('taskId') ?? '')), {
    initialValue: '',
  });
}
