import { Component, inject } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';

import { SessionService } from '../services/session.service';

@Component({
  selector: 'app-queue-page',
  imports: [ButtonModule, MessageModule],
  template: `
    <section class="page">
      <header class="page__header">
        <h1>Queue</h1>
        <p>Phase 8A establishes routing, session bootstrap, and the typed task API boundary.</p>
      </header>

      <p-message severity="info" text="Queue tables and filters are intentionally deferred to Phase 8B." />

      <div class="metric-strip">
        <div class="metric">
          <span class="metric__label">API path</span>
          <span class="metric__value">{{ sessionService.session()?.apiPath || '/api' }}</span>
        </div>
        <div class="metric">
          <span class="metric__label">UI path</span>
          <span class="metric__value">{{ sessionService.session()?.uiPath || '/tasks' }}</span>
        </div>
        <div class="metric">
          <span class="metric__label">Role</span>
          <span class="metric__value">{{ sessionService.session()?.role || 'pending' }}</span>
        </div>
      </div>
    </section>
  `,
})
export class QueuePageComponent {
  protected readonly sessionService = inject(SessionService);
}
