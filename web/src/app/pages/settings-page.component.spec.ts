import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import Aura from '@primeuix/themes/aura';
import { providePrimeNG } from 'primeng/config';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter } from '@angular/router';
import { SettingsPageComponent } from './settings-page.component';
import { SettingsViewDto } from '../models/settings.dto';
const empty: SettingsViewDto = { revision: 0, connections: [], projects: [], workers: [], allowedOrigins: ['https://gitlab.test'] };
describe('Managed settings UI', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [SettingsPageComponent], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideAnimationsAsync(), providePrimeNG({ theme: { preset: Aura } })] }).compileComponents();
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  it('renders setup with zero projects and clears a submitted credential', () => {
    const fixture = TestBed.createComponent(SettingsPageComponent); fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController); http.expectOne('/api/settings').flush(empty); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Первоначальная настройка');
    fixture.componentInstance.connection = { name: 'GitLab', origin: 'https://gitlab.test', token: 'test-secret' };
    fixture.componentInstance.connect();
    expect(fixture.componentInstance.connection.token).toBe('');
    const request = http.expectOne('/api/settings/connections');
    expect(request.request.body.expectedRevision).toBe(0);
    request.flush({ ...empty, revision: 1, connections: [{ id: 'connection', name: 'GitLab', origin: 'https://gitlab.test', revision: 1, credentialConfigured: true }] });
    fixture.detectChanges(); expect(fixture.nativeElement.textContent).not.toContain('test-secret'); fixture.destroy();
  });
  it('keeps the editing revision when another refresh observes a newer version', () => {
    const fixture = TestBed.createComponent(SettingsPageComponent); fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController); http.expectOne('/api/settings').flush(empty);
    const component = fixture.componentInstance; component.startProject();
    component.refresh(); http.expectOne('/api/settings').flush({ ...empty, revision: 3 });
    component.saveProject();
    const request = http.expectOne('/api/settings/projects'); expect(request.request.body.expectedRevision).toBe(0);
    request.flush({ error: 'Настройки изменились' }, { status: 409, statusText: 'Conflict' });
    expect(component.editing()).toBeTrue(); expect(component.error()).toContain('изменились'); fixture.destroy();
  });
  it('removes loaded settings after access is denied', () => {
    const fixture = TestBed.createComponent(SettingsPageComponent); fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController); http.expectOne('/api/settings').flush(empty);
    fixture.componentInstance.refresh(); http.expectOne('/api/settings').flush({ error: 'denied' }, { status: 403, statusText: 'Forbidden' });
    expect(fixture.componentInstance.view()).toBeUndefined(); fixture.destroy();
  });
});
