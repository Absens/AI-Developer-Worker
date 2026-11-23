import { HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import {
  AgentContextPreviewResponseDto,
  CreateTaskRequestDto,
  CreateTaskResponseDto,
  CommandResponseDto,
  TaskDetailResponseDto,
  TaskListResponseDto,
  TaskStatusDto,
  TimelineEventDto,
} from '../models/human-api.dto';
import { ApiClient } from './api-client.service';
import {
  mapCreateTaskResponse,
  mapCommandResponse,
  mapEvent,
  mapTaskDetailResponse,
  mapTaskListResponse,
} from './task-mappers';

export interface TaskListFilters {
  status?: TaskStatusDto[];
  search?: string;
  cursor?: string;
  repository?: string;
  queue?: string;
  priority?: string;
  worker?: string;
  tag?: string;
  limit?: number;
}

export interface DraftRevisionRequest {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  expectedRevisionNumber: number;
  expectedStatus: 'new';
}

@Injectable({ providedIn: 'root' })
export class TaskApiService {
  private readonly api = inject(ApiClient);

  listTasks(filters: TaskListFilters = {}): Observable<TaskListResponseDto> {
    let params = new HttpParams();
    for (const status of filters.status ?? []) {
      params = params.append('status', status);
    }
    for (const [key, value] of Object.entries(filters)) {
      if (key !== 'status' && value !== undefined && value !== '') {
        params = params.set(key, String(value));
      }
    }

    return this.api.get<unknown>('/tasks', params).pipe(map(mapTaskListResponse));
  }

  getTask(taskId: string): Observable<TaskDetailResponseDto> {
    return this.api
      .get<unknown>(`/tasks/${encodeURIComponent(taskId)}`)
      .pipe(map(mapTaskDetailResponse));
  }

  createTask(request: CreateTaskRequestDto): Observable<CreateTaskResponseDto> {
    return this.api.post<CreateTaskRequestDto, unknown>('/tasks', request).pipe(map(mapCreateTaskResponse));
  }

  updateDraftRevision(taskId: string, request: DraftRevisionRequest): Observable<CommandResponseDto> {
    return this.api.post<DraftRevisionRequest, unknown>(
      `/tasks/${encodeURIComponent(taskId)}/revisions`, request,
    ).pipe(map(mapCommandResponse));
  }

  getEvents(taskId: string): Observable<TimelineEventDto[]> {
    return this.api.get<{ events?: unknown[] }>(`/tasks/${encodeURIComponent(taskId)}/events`).pipe(
      map((response) => (response.events ?? []).map(mapEvent)),
    );
  }

  getAgentContextPreview(taskId: string): Observable<AgentContextPreviewResponseDto> {
    return this.api.get<AgentContextPreviewResponseDto>(
      `/tasks/${encodeURIComponent(taskId)}/agent-context-preview`,
    );
  }
}
