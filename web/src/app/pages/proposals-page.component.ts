import { Component } from '@angular/core';
import { MessageModule } from 'primeng/message';

@Component({
  selector: 'app-proposals-page',
  imports: [MessageModule],
  template: `
    <section class="page">
      <header class="page__header">
        <h1>Proposals</h1>
        <p>Proposal list and approval actions remain deferred to Phase 8B.</p>
      </header>
      <p-message severity="secondary" text="The typed proposal service is available for the next phase." />
    </section>
  `,
})
export class ProposalsPageComponent {}
