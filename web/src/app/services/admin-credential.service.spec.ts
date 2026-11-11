import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AdminCredentialService, adminCredentialInterceptor } from './admin-credential.service';
describe('Ephemeral admin credential', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([adminCredentialInterceptor])), provideHttpClientTesting()] }));
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  it('forwards credentials only to same-origin application API routes', () => {
    const credential = TestBed.inject(AdminCredentialService); credential.set('test-token');
    const client = TestBed.inject(HttpClient); const http = TestBed.inject(HttpTestingController);
    for (const url of ['/api/settings', '/api/session', 'https://example.test/api/settings', '//example.test/api/settings', '/api-malicious', '/assets/data']) {
      client.get(url).subscribe();
      const request = http.expectOne(url);
      expect(request.request.headers.get('Authorization')).toBe(url === '/api/settings' || url === '/api/session' ? 'Bearer test-token' : null);
      request.flush({});
    }
  });
  it('does not persist the admin token and stops forwarding after logout', () => {
    const local = spyOn(Storage.prototype, 'setItem');
    const credential = TestBed.inject(AdminCredentialService); credential.set('test-token'); credential.clear();
    expect(credential.token()).toBe(''); expect(local).not.toHaveBeenCalled();
    TestBed.inject(HttpClient).get('/api/settings').subscribe();
    const request = TestBed.inject(HttpTestingController).expectOne('/api/settings');
    expect(request.request.headers.has('Authorization')).toBeFalse(); request.flush({});
  });
});
