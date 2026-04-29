import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';

@Component({
  selector: 'app-not-found-page',
  imports: [ButtonModule, RouterLink],
  template: `
    <section class="page">
      <header class="page__header">
        <h1>Not Found</h1>
        <p>The requested console route does not exist.</p>
      </header>
      <a pButton routerLink="/" icon="pi pi-list" label="Back to queue"></a>
    </section>
  `,
})
export class NotFoundPageComponent {}
