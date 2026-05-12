import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';

import { ApiErrorDto, SessionDto } from '../models/human-api.dto';

interface SessionState {
  loading: boolean;
  session?: SessionDto;
  error?: string;
}

const errorMessage = (error: unknown): string => {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as Partial<ApiErrorDto> | undefined;
    return body?.error || error.message;
  }
  return error instanceof Error ? error.message : String(error);
};

@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly http = inject(HttpClient);
  private readonly state = signal<SessionState>({ loading: false });

  readonly loading = computed(() => this.state().loading);
  readonly session = computed(() => this.state().session);
  readonly error = computed(() => this.state().error);
  readonly apiPath = computed(() => this.state().session?.apiPath || '/api');

  load(): void {
    if (this.state().loading) {
      return;
    }

    this.state.set({ ...this.state(), loading: true, error: undefined });
    this.http.get<SessionDto>('/api/session', { headers: { 'cache-control': 'no-store' } }).subscribe({
      next: (session) => this.state.set({ loading: false, session }),
      error: (error: unknown) =>
        this.state.set({
          loading: false,
          session: this.state().session,
          error: errorMessage(error),
        }),
    });
  }
}
