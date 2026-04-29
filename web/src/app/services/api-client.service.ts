import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

import { ApiErrorDto } from '../models/human-api.dto';
import { SessionService } from './session.service';

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionService);

  get<TResponse>(path: string, params?: HttpParams): Observable<TResponse> {
    return this.http
      .get<TResponse>(this.url(path), { params, headers: { 'cache-control': 'no-store' } })
      .pipe(catchError((error: unknown) => throwError(() => this.toError(error))));
  }

  post<TRequest, TResponse>(path: string, body: TRequest): Observable<TResponse> {
    return this.http
      .post<TResponse>(this.url(path), body)
      .pipe(catchError((error: unknown) => throwError(() => this.toError(error))));
  }

  private url(path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${this.session.apiPath()}${normalized}`;
  }

  private toError(error: unknown): Error {
    if (error instanceof HttpErrorResponse) {
      const body = error.error as Partial<ApiErrorDto> | undefined;
      return new Error(body?.error || error.message);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
