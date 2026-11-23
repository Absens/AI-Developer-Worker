import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';

@Component({
  selector: 'app-not-found-page',
  imports: [ButtonModule, RouterLink],
  template: `
    <section class="page">
      <header class="page__header">
        <div>
          <h1>Страница не найдена</h1>
          <p>Проверьте адрес или вернитесь в очередь задач.</p>
        </div>
      </header>
      <div class="action-bar">
        <a pButton routerLink="/" icon="pi pi-list" label="К очереди"></a>
      </div>
    </section>
  `,
})
export class NotFoundPageComponent {}
