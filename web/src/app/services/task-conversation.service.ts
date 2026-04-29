import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import {
  AnswerTaskRequestDto,
  CommandResponseDto,
  TaskConversationResponseDto,
} from '../models/human-api.dto';
import { ApiClient } from './api-client.service';
import { mapCommandResponse, mapConversationResponse } from './task-mappers';

@Injectable({ providedIn: 'root' })
export class TaskConversationService {
  private readonly api = inject(ApiClient);

  list(taskId: string): Observable<TaskConversationResponseDto> {
    return this.api
      .get<unknown>(`/tasks/${encodeURIComponent(taskId)}/comments`)
      .pipe(map(mapConversationResponse));
  }

  answer(taskId: string, request: AnswerTaskRequestDto): Observable<CommandResponseDto> {
    return this.api
      .post<AnswerTaskRequestDto, unknown>(`/tasks/${encodeURIComponent(taskId)}/answers`, request)
      .pipe(map(mapCommandResponse));
  }
}
