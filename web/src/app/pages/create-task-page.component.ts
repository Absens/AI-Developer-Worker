import { Component } from '@angular/core';
import { MessageModule } from 'primeng/message';

@Component({
  selector: 'app-create-task-page',
  imports: [MessageModule],
  template: `
    <section class="page">
      <header class="page__header">
        <h1>Create Task</h1>
        <p>Reactive task creation forms will be added in Phase 8B.</p>
      </header>
      <p-message severity="secondary" text="Create-task service DTOs are present; workflow controls are not implemented in Phase 8A." />
    </section>
  `,
})
export class CreateTaskPageComponent {}
