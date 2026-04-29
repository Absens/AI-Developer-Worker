import { Component } from '@angular/core';
import { MessageModule } from 'primeng/message';

@Component({
  selector: 'app-operations-page',
  imports: [MessageModule],
  template: `
    <section class="page">
      <header class="page__header">
        <h1>Operations</h1>
        <p>Fleet, lease, and failure views are Phase 8C scope.</p>
      </header>
      <p-message severity="secondary" text="The operations snapshot service is wired for the later operations console." />
    </section>
  `,
})
export class OperationsPageComponent {}
