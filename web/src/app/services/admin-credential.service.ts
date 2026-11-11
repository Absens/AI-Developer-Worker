import { Injectable, inject } from '@angular/core';
import { HttpInterceptorFn } from '@angular/common/http';

/** Ephemeral only: never localStorage, sessionStorage, cookies or URL parameters. */
@Injectable({ providedIn: 'root' })
export class AdminCredentialService {
  private value = '';
  set(value: string): void { this.value = value.trim(); }
  clear(): void { this.value = ''; }
  token(): string { return this.value; }
}
export const adminCredentialInterceptor: HttpInterceptorFn = (request, next) => {
  const token = inject(AdminCredentialService).token();
  // Restrict forwarding to the app's same-origin API; never attach credentials to external URLs.
  if (token && /^\/api(?:\/|$)/.test(request.url)) {
    request = request.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }
  return next(request);
};
