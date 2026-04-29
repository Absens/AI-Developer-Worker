import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ToolbarModule } from 'primeng/toolbar';

import { SessionService } from './services/session.service';

@Component({
  selector: 'app-root',
  imports: [
    ButtonModule,
    ConfirmDialogModule,
    MessageModule,
    ProgressSpinnerModule,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    TagModule,
    ToastModule,
    ToolbarModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly sessionService = inject(SessionService);
  protected readonly navItems = [
    { label: 'Queue', icon: 'pi pi-list', route: '/' },
    { label: 'Create', icon: 'pi pi-plus-circle', route: '/new' },
    { label: 'Proposals', icon: 'pi pi-verified', route: '/proposals' },
    { label: 'Operations', icon: 'pi pi-server', route: '/operations' },
  ];

  constructor() {
    this.sessionService.load();
  }

  protected retrySession(): void {
    this.sessionService.load();
  }
}
