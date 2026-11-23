import { HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ProposalListResponseDto } from '../models/human-api.dto';
import { ApiClient } from './api-client.service';
import { mapProposalListResponse } from './task-mappers';

@Injectable({ providedIn: 'root' })
export class ProposalService {
  private readonly api = inject(ApiClient);

  list(supervisorStatus?: string, repositoryName?: string): Observable<ProposalListResponseDto> {
    let params = new HttpParams();
    if (supervisorStatus) params = params.set('supervisorStatus', supervisorStatus);
    if (repositoryName) params = params.set('repositoryName', repositoryName);
    return this.api.get<unknown>('/proposals', params).pipe(map(mapProposalListResponse));
  }

  create(request: Record<string, unknown>): Observable<unknown> {
    return this.api.post<Record<string, unknown>, unknown>('/proposals', request);
  }
}
