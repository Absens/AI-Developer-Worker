import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { TaskApiService } from './task-api.service';

describe('TaskApiService', () => {
  let service: TaskApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(TaskApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  it('sends repeated status query parameters with conservative limit', () => {
    service
      .listTasks({
        status: ['ready', 'failed'],
        repository: 'developer',
        queue: 'DEV',
        priority: 'normal',
        worker: 'worker-1',
        tag: 'ai_dev',
        limit: 100,
      })
      .subscribe((response) => {
        expect(response.tasks).toEqual([]);
      });

    const request = http.expectOne((entry) => entry.url === '/api/tasks');
    expect(request.request.params.getAll('status')).toEqual(['ready', 'failed']);
    expect(request.request.params.get('repository')).toBe('developer');
    expect(request.request.params.get('queue')).toBe('DEV');
    expect(request.request.params.get('priority')).toBe('normal');
    expect(request.request.params.get('worker')).toBe('worker-1');
    expect(request.request.params.get('tag')).toBe('ai_dev');
    expect(request.request.params.get('limit')).toBe('100');
    request.flush({ tasks: [], role: 'viewer', generatedAt: '2026-04-29T00:00:00.000Z' });
  });
});
