import { HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import {
  ProjectAnalysisKindDto,
  ProjectAnalysisListResponseDto,
  ProjectGoalCommandResponseDto,
  ProjectGoalDetailResponseDto,
  ProjectGoalListResponseDto,
  ProjectGoalProposeTasksResponseDto,
} from '../models/human-api.dto';
import { ApiClient } from './api-client.service';
import {
  mapProjectAnalysisListResponse,
  mapProjectGoalCommandResponse,
  mapProjectGoalDetailResponse,
  mapProjectGoalListResponse,
  mapProjectGoalProposeTasksResponse,
} from './task-mappers';

@Injectable({ providedIn: 'root' })
export class ProjectGoalService {
  private readonly api = inject(ApiClient);

  list(input: { repositoryName?: string; status?: string } = {}): Observable<ProjectGoalListResponseDto> {
    let params = new HttpParams();
    if (input.repositoryName) {
      params = params.set('repositoryName', input.repositoryName);
    }
    if (input.status) {
      params = params.set('status', input.status);
    }
    return this.api.get<unknown>('/project-goals', params).pipe(map(mapProjectGoalListResponse));
  }

  get(goalId: string): Observable<ProjectGoalDetailResponseDto> {
    return this.api
      .get<unknown>(`/project-goals/${encodeURIComponent(goalId)}`)
      .pipe(map(mapProjectGoalDetailResponse));
  }

  approve(goalId: string): Observable<ProjectGoalCommandResponseDto> {
    return this.api
      .post<Record<string, never>, unknown>(
        `/project-goals/${encodeURIComponent(goalId)}/commands/approve`,
        {},
      )
      .pipe(map(mapProjectGoalCommandResponse));
  }

  reject(goalId: string, reason: string): Observable<ProjectGoalCommandResponseDto> {
    return this.api
      .post<{ reason: string }, unknown>(
        `/project-goals/${encodeURIComponent(goalId)}/commands/reject`,
        { reason },
      )
      .pipe(map(mapProjectGoalCommandResponse));
  }

  proposeTasks(goalId: string): Observable<ProjectGoalProposeTasksResponseDto> {
    return this.api
      .post<Record<string, never>, unknown>(
        `/project-goals/${encodeURIComponent(goalId)}/commands/propose-tasks`,
        {},
      )
      .pipe(map(mapProjectGoalProposeTasksResponse));
  }

  complete(goalId: string): Observable<ProjectGoalCommandResponseDto> {
    return this.api
      .post<Record<string, never>, unknown>(
        `/project-goals/${encodeURIComponent(goalId)}/commands/complete`,
        {},
      )
      .pipe(map(mapProjectGoalCommandResponse));
  }

  markStale(goalId: string, reason: string): Observable<ProjectGoalCommandResponseDto> {
    return this.api
      .post<{ reason: string }, unknown>(
        `/project-goals/${encodeURIComponent(goalId)}/commands/stale`,
        { reason },
      )
      .pipe(map(mapProjectGoalCommandResponse));
  }

  runAnalysis(repositoryName: string): Observable<unknown> {
    return this.api.post<{ repositoryName: string }, unknown>('/project-manager/runs', {
      repositoryName,
    });
  }

  runReplan(repositoryName: string, replanReason: string): Observable<unknown> {
    return this.api.post<{ repositoryName: string; mode: 'replan'; replanReason: string }, unknown>(
      '/project-manager/runs',
      {
        repositoryName,
        mode: 'replan',
        replanReason,
      },
    );
  }

  runStrategy(repositoryName: string, strategyBrief?: string): Observable<unknown> {
    return this.api.post<
      { repositoryName: string; mode: 'strategy'; strategyBrief?: string },
      unknown
    >('/project-manager/runs', {
      repositoryName,
      mode: 'strategy',
      ...(strategyBrief?.trim() ? { strategyBrief: strategyBrief.trim() } : {}),
    });
  }

  listAnalyses(input: {
    repositoryName?: string;
    analysisKind?: ProjectAnalysisKindDto;
  } = {}): Observable<ProjectAnalysisListResponseDto> {
    let params = new HttpParams();
    if (input.repositoryName) {
      params = params.set('repositoryName', input.repositoryName);
    }
    if (input.analysisKind) {
      params = params.set('analysisKind', input.analysisKind);
    }
    return this.api
      .get<unknown>('/project-manager/analyses', params)
      .pipe(map(mapProjectAnalysisListResponse));
  }
}
