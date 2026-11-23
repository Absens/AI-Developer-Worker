import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { AdminCredentialService } from './services/admin-credential.service';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { filter } from 'rxjs';

import { SessionRoleDto } from './models/human-api.dto';
import { SessionService } from './services/session.service';
import { canUseCapability } from './utils/task-ui';

interface NavItem {
  label: string;
  icon: string;
  route: string;
  testId: string;
  capability?: string;
}

const ROLE_LABELS: Record<SessionRoleDto, string> = {
  viewer: 'Наблюдатель',
  developer: 'Разработчик',
  operator: 'Оператор',
  admin: 'Администратор',
};

@Component({
  selector: 'app-root',
  imports: [
    FormsModule, InputTextModule,
    ButtonModule,
    ConfirmDialogModule,
    MessageModule,
    RouterLink,
    RouterOutlet,
    TagModule,
    ToastModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected adminToken = '';
  private readonly credential = inject(AdminCredentialService);
  private readonly router = inject(Router);

  protected readonly menuOpen = signal(false);
  protected readonly activeSection = signal<string | undefined>(undefined);
  protected readonly roleLabels = ROLE_LABELS;

  protected login(): void {
    this.credential.set(this.adminToken);
    this.adminToken = '';
    this.sessionService.load();
  }
  protected logout(): void {
    this.credential.clear();
    this.sessionService.clear();
    this.sessionService.load();
  }

  protected readonly sessionService = inject(SessionService);
  protected readonly navItems: NavItem[] = [
    { label: 'Очередь', icon: 'pi pi-list', route: '/', testId: 'nav-queue', capability: 'canReadTasks' },
    {
      label: 'Новая задача',
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
    { label: 'Настройки', icon: 'pi pi-cog', route: '/settings', testId: 'nav-settings', capability: 'canManageSettings' },
  ];
  protected readonly visibleNavItems = computed(() => {
    const session = this.sessionService.session();
    return this.navItems.filter(
      (item) => !item.capability || canUseCapability(session, item.capability),
    );
  });

  constructor() {
    this.updateActiveSection();
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      takeUntilDestroyed(),
    ).subscribe((event) => {
      const nextPath = event.urlAfterRedirects.split(/[?#]/u)[0];
      if (this.currentPath !== nextPath) {
        this.currentPath = nextPath;
        window.scrollTo(0, 0);
      }
      this.updateActiveSection();
    });
    this.sessionService.load();
  }

  private currentPath = '';

  protected closeMenu(event: MouseEvent, main: HTMLElement): void {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !this.menuOpen()) {
      return;
    }
    this.menuOpen.set(false);
    main.focus({ preventScroll: true });
  }

  private updateActiveSection(): void {
    const path = this.router.routerState.snapshot.root.firstChild?.routeConfig?.path;
    const section = path === ':taskId' ? '' : path?.split('/')[0];
    this.activeSection.set(section === undefined ? undefined : `/${section}`);
    this.menuOpen.set(false);
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
      return 'Вход по токену';
    }
    return 'Доверенный прокси';
  }

}
