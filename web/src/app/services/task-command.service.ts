import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { CommandResponseDto } from '../models/human-api.dto';
import { ApiClient } from './api-client.service';
import { mapCommandResponse } from './task-mappers';

export type TaskCommandName =
  | 'mark-ready'
  | 'resume'
  | 'cancel'
  | 'approve-decomposition'
  | 'approve-proposal'
  | 'reject-proposal'
  | 'hold'
  | 'retry'
  | 'force-reanalysis';

export interface TaskCommandRequest {
  reason?: string;
  approve?: boolean;
}

@Injectable({ providedIn: 'root' })
export class TaskCommandService {
  private readonly api = inject(ApiClient);

  run(
    taskId: string,
    command: TaskCommandName,
    request: TaskCommandRequest = {},
  ): Observable<CommandResponseDto> {
    return this.api
      .post<TaskCommandRequest, unknown>(
        `/tasks/${encodeURIComponent(taskId)}/commands/${command}`,
        request,
      )
      .pipe(map(mapCommandResponse));
  }
}
