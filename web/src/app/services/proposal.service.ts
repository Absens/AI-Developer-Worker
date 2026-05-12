import { HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ProposalListResponseDto } from '../models/human-api.dto';
import { ApiClient } from './api-client.service';
import { mapProposalListResponse } from './task-mappers';

@Injectable({ providedIn: 'root' })
export class ProposalService {
  private readonly api = inject(ApiClient);

  list(supervisorStatus?: string): Observable<ProposalListResponseDto> {
    const params = supervisorStatus ? new HttpParams().set('supervisorStatus', supervisorStatus) : undefined;
    return this.api.get<unknown>('/proposals', params).pipe(map(mapProposalListResponse));
  }

  create(request: Record<string, unknown>): Observable<unknown> {
    return this.api.post<Record<string, unknown>, unknown>('/proposals', request);
  }
}
