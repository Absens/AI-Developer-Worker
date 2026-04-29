import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { MessageModule } from 'primeng/message';

@Component({
  selector: 'app-task-detail-page',
  imports: [MessageModule],
  template: `
    <section class="page">
      <header class="page__header">
        <h1>Task Detail</h1>
        <p>Deep link target: {{ taskId }}</p>
      </header>
      <p-message severity="secondary" text="Detail, timeline, validation, MR, and question workflows are Phase 8B scope." />
    </section>
  `,
})
export class TaskDetailPageComponent {
  protected readonly taskId = inject(ActivatedRoute).snapshot.paramMap.get('taskId') || '';
}
