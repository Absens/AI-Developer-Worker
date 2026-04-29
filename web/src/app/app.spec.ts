import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import Aura from '@primeuix/themes/aura';
import { ConfirmationService, MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';

import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        providePrimeNG({ theme: { preset: Aura } }),
        ConfirmationService,
        MessageService,
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    const app = fixture.componentInstance;
    http.expectOne('/api/session').flush({
      user: { id: 'viewer-1', service: 'human' },
      role: 'viewer',
      authMode: 'trusted_proxy',
      capabilities: { canReadTasks: true },
      apiPath: '/api',
      uiPath: '/tasks',
      generatedAt: '2026-04-29T00:00:00.000Z',
    });
    expect(app).toBeTruthy();
    http.verify();
  });

  it('should render the console shell', () => {
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/session').flush({
      user: { id: 'viewer-1', displayName: 'Viewer One', service: 'human' },
      role: 'viewer',
      authMode: 'trusted_proxy',
      capabilities: { canReadTasks: true },
      apiPath: '/api',
      uiPath: '/tasks',
      generatedAt: '2026-04-29T00:00:00.000Z',
    });
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.console-title')?.textContent).toContain('Task Tracker Console');
    expect(compiled.textContent).toContain('Viewer One');
    http.verify();
  });
});
