import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { OperationsSnapshotDto } from '../models/human-api.dto';
import { ApiClient } from './api-client.service';
import { mapOperationsSnapshot } from './task-mappers';

@Injectable({ providedIn: 'root' })
export class OperationsService {
  private readonly api = inject(ApiClient);

  snapshot(): Observable<OperationsSnapshotDto> {
    return this.api.get<unknown>('/operations').pipe(map(mapOperationsSnapshot));
  }
}
