import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';

@Component({
  selector: 'app-not-found-page',
  imports: [ButtonModule, RouterLink],
  template: `
    <section class="page">
      <header class="page__header">
        <h1>Страница не найдена</h1>
        <p>Такого раздела консоли нет.</p>
      </header>
      <a pButton routerLink="/" icon="pi pi-list" label="К очереди"></a>
    </section>
  `,
})
export class NotFoundPageComponent {}
