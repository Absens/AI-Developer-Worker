import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import {
  approvedProjectGoal,
  projectGoal,
  projectGoalDetail,
  projectGoalList,
  readyTaskDetail,
} from '../testing/human-api.fixtures';
import { ProjectGoalService } from './project-goal.service';

describe('ProjectGoalService', () => {
  let service: ProjectGoalService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ProjectGoalService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  it('lists project goals with repository and status filters', () => {
    service.list({ repositoryName: 'developer', status: 'proposed' }).subscribe((response) => {
      expect(response).toEqual(projectGoalList);
      expect(response.goals[0].suggestedTaskProposals[0].acceptanceCriteria).toEqual([
        'Proposal review shows the goal context.',
      ]);
    });

    const request = http.expectOne((entry) => entry.url === '/api/project-goals');
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('repositoryName')).toBe('developer');
    expect(request.request.params.get('status')).toBe('proposed');
    request.flush(projectGoalList);
  });

  it('gets a project goal detail by encoded goal id', () => {
    service.get('pm_goal/with space').subscribe((response) => {
      expect(response).toEqual(projectGoalDetail);
      expect(response.auditEvents[0].actor?.displayName).toBe('Project Manager');
      expect(response.linkedTasks[0].title).toBe(readyTaskDetail.summary.title);
    });

    const request = http.expectOne('/api/project-goals/pm_goal%2Fwith%20space');
    expect(request.request.method).toBe('GET');
    request.flush(projectGoalDetail);
  });

  it('approves a project goal with an empty command body', () => {
    service.approve(projectGoal.id).subscribe((response) => {
      expect(response.goal.status).toBe('approved');
    });

    const request = http.expectOne(`/api/project-goals/${projectGoal.id}/commands/approve`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({});
    request.flush({ goal: approvedProjectGoal });
  });

  it('rejects a project goal with a reason body', () => {
    service.reject(projectGoal.id, 'Superseded by a smaller goal.').subscribe((response) => {
      expect(response.goal.status).toBe('rejected');
      expect(response.goal.rejectionReason).toBe('Superseded by a smaller goal.');
    });

    const request = http.expectOne(`/api/project-goals/${projectGoal.id}/commands/reject`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ reason: 'Superseded by a smaller goal.' });
    request.flush({
      goal: {
        ...projectGoal,
        status: 'rejected',
        rejectedAt: '2026-04-29T08:05:00.000Z',
        rejectionReason: 'Superseded by a smaller goal.',
      },
    });
  });

  it('proposes tasks for a project goal and maps task links', () => {
    service.proposeTasks(projectGoal.id).subscribe((response) => {
      expect(response.goal.id).toBe(projectGoal.id);
      expect(response.tasks[0].id).toBe(readyTaskDetail.task.id);
      expect(response.taskLinks[0].taskId).toBe(readyTaskDetail.task.id);
      expect(response.proposals).toEqual([{ id: readyTaskDetail.task.id }]);
    });

    const request = http.expectOne(`/api/project-goals/${projectGoal.id}/commands/propose-tasks`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({});
    request.flush({
      goal: projectGoal,
      tasks: [readyTaskDetail.task],
      proposals: [{ id: readyTaskDetail.task.id }],
      taskLinks: projectGoalDetail.taskLinks,
    });
  });

  it('completes a project goal with an empty command body', () => {
    service.complete(approvedProjectGoal.id).subscribe((response) => {
      expect(response.goal.status).toBe('completed');
      expect(response.goal.completedAt).toBe('2026-04-29T08:06:00.000Z');
    });

    const request = http.expectOne(`/api/project-goals/${approvedProjectGoal.id}/commands/complete`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({});
    request.flush({
      goal: {
        ...approvedProjectGoal,
        status: 'completed',
        completedAt: '2026-04-29T08:06:00.000Z',
      },
    });
  });

  it('marks a project goal stale with a reason body', () => {
    service.markStale(approvedProjectGoal.id, 'The repository moved to another plan.').subscribe((response) => {
      expect(response.goal.status).toBe('stale');
      expect(response.goal.staleReason).toBe('The repository moved to another plan.');
    });

    const request = http.expectOne(`/api/project-goals/${approvedProjectGoal.id}/commands/stale`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ reason: 'The repository moved to another plan.' });
    request.flush({
      goal: {
        ...approvedProjectGoal,
        status: 'stale',
        staleAt: '2026-04-29T08:07:00.000Z',
        staleReason: 'The repository moved to another plan.',
      },
    });
  });

  it('runs project manager analysis for a repository', () => {
    const runResponse = { runId: 'pm-run-1', accepted: true };

    service.runAnalysis('developer').subscribe((response) => {
      expect(response).toEqual(runResponse);
    });

    const request = http.expectOne('/api/project-manager/runs');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ repositoryName: 'developer' });
    request.flush(runResponse);
  });
});
