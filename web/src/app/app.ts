import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ToolbarModule } from 'primeng/toolbar';

import { SessionService } from './services/session.service';
import { canUseCapability } from './utils/task-ui';

interface NavItem {
  label: string;
  icon: string;
  route: string;
  testId: string;
  capability?: string;
}

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
  protected readonly navItems: NavItem[] = [
    { label: 'Очередь', icon: 'pi pi-list', route: '/', testId: 'nav-queue', capability: 'canReadTasks' },
    {
      label: 'Создать',
      icon: 'pi pi-plus-circle',
      route: '/new',
      testId: 'nav-create',
      capability: 'canCreateTask',
    },
    {
      label: 'Предложения',
      icon: 'pi pi-verified',
      route: '/proposals',
      testId: 'nav-proposals',
      capability: 'canReadTasks',
    },
    {
      label: 'Цели',
      icon: 'pi pi-sitemap',
      route: '/goals',
      testId: 'nav-goals',
      capability: 'canReadProjectGoals',
    },
    {
      label: 'Операции',
      icon: 'pi pi-server',
      route: '/operations',
      testId: 'nav-operations',
      capability: 'canReadOperations',
    },
  ];
  protected readonly visibleNavItems = computed(() => {
    const session = this.sessionService.session();
    return this.navItems.filter(
      (item) => !item.capability || canUseCapability(session, item.capability),
    );
  });

  constructor() {
    this.sessionService.load();
  }

  protected retrySession(): void {
    this.sessionService.load();
  }

  protected authModeLabel(): string {
    const authMode = this.sessionService.session()?.authMode;
    if (authMode === 'localhost') {
      return 'Локальная разработка';
    }
    if (authMode === 'bearer') {
      return 'Bearer';
    }
    return 'Доверенный прокси';
  }

  protected authModeSeverity(): 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' {
    const authMode = this.sessionService.session()?.authMode;
    if (authMode === 'localhost') {
      return 'warn';
    }
    if (authMode === 'bearer') {
      return 'contrast';
    }
    return 'secondary';
  }
}
