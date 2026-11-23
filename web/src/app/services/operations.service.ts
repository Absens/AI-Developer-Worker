import { HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { OperationsSnapshotDto } from '../models/human-api.dto';
import { ApiClient } from './api-client.service';
import { mapOperationsSnapshot } from './task-mappers';

@Injectable({ providedIn: 'root' })
export class OperationsService {
  private readonly api = inject(ApiClient);

  snapshot(repository?: string): Observable<OperationsSnapshotDto> {
    const params = repository ? new HttpParams().set('repository', repository) : undefined;
    return this.api.get<unknown>('/operations', params).pipe(map(mapOperationsSnapshot));
  }
}
