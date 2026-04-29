import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { Router, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import Aura from '@primeuix/themes/aura';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';

import { TaskDetailPanelComponent } from '../components/task-detail-panel.component';
import { SessionService } from '../services/session.service';
import { TASK_COMMAND_POLICIES } from '../utils/task-ui';
import { CreateTaskPageComponent } from './create-task-page.component';
import { ProposalsPageComponent } from './proposals-page.component';
import { QueuePageComponent } from './queue-page.component';
import {
  awaitingTaskDetail,
  blockedTask,
  developerSession,
  draftTask,
  failedTask,
  mrValidationTaskDetail,
  operatorSession,
  proposedTask,
  readyTask,
  readyTaskDetail,
  viewerSession,
} from '../testing/human-api.fixtures';

const configure = async (imports: unknown[]): Promise<HttpTestingController> => {
  await TestBed.configureTestingModule({
    imports,
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideAnimationsAsync(),
      providePrimeNG({ theme: { preset: Aura } }),
      MessageService,
    ],
  }).compileComponents();
  return TestBed.inject(HttpTestingController);
};

const loadSession = (http: HttpTestingController, session = developerSession): void => {
  TestBed.inject(SessionService).load();
  http.expectOne('/api/session').flush(session);
};

describe('QueuePageComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders grouped queue tasks with empty detail selection', async () => {
    const http = await configure([QueuePageComponent]);
    loadSession(http, viewerSession);

    const fixture = TestBed.createComponent(QueuePageComponent);
    fixture.detectChanges();

    const request = http.expectOne((entry) => entry.url === '/api/tasks');
    expect(request.request.params.get('limit')).toBe('100');
    request.flush({
      tasks: [readyTask, awaitingTaskDetail.summary, failedTask, blockedTask, draftTask],
      role: 'viewer',
      generatedAt: '2026-04-29T08:00:00.000Z',
    });
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Ready');
    expect(text).toContain('Awaiting Human');
    expect(text).toContain('Failed');
    expect(text).toContain('Implement ready queue item');
    expect(text).toContain('Need API decision');
    expect(text).toContain('Select a task');
  });
});

describe('TaskDetailPanelComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('uses session capabilities for action visibility and renders MR/validation summaries', async () => {
    const http = await configure([TaskDetailPanelComponent]);
    loadSession(http, developerSession);

    const fixture = TestBed.createComponent(TaskDetailPanelComponent);
    fixture.componentRef.setInput('taskId', 'mr-task');
    http.expectOne('/api/tasks/mr-task').flush(mrValidationTaskDetail);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Task with MR and validation');
    expect(text).toContain('Tests passed.');
    expect(text).toContain('MR title');
    expect(text).toContain('Cancel');
  });

  it('hides mutation actions for a viewer session', async () => {
    const http = await configure([TaskDetailPanelComponent]);
    loadSession(http, viewerSession);

    const fixture = TestBed.createComponent(TaskDetailPanelComponent);
    fixture.componentRef.setInput('taskId', 'ready-task');
    http.expectOne('/api/tasks/ready-task').flush(readyTaskDetail);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Preview context');
    expect(text).not.toContain('Cancel');
    expect(text).not.toContain('Hold');
  });

  it('renders allowlisted agent context preview fields', async () => {
    const http = await configure([TaskDetailPanelComponent]);
    loadSession(http, developerSession);

    const fixture = TestBed.createComponent(TaskDetailPanelComponent);
    fixture.componentRef.setInput('taskId', 'ready-task');
    http.expectOne('/api/tasks/ready-task').flush(readyTaskDetail);

    (fixture.componentInstance as unknown as { openAgentContext: () => void }).openAgentContext();
    http.expectOne('/api/tasks/ready-task/agent-context-preview').flush({
      agentContext: {
        taskId: 'ready-task',
        title: 'Implement ready queue item',
        description: 'Context description',
        acceptanceCriteria: ['Expected behavior is implemented.'],
        events: [{ kind: 'task_created' }],
      },
    });
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Task ID');
    expect(text).toContain('ready-task');
    expect(text).toContain('Acceptance Criteria');
    expect(text).toContain('Events');
  });

  it('answers and resumes through the answer endpoint with a resume command', async () => {
    const http = await configure([TaskDetailPanelComponent]);
    loadSession(http, developerSession);

    const fixture = TestBed.createComponent(TaskDetailPanelComponent);
    fixture.componentRef.setInput('taskId', 'awaiting-task');
    http.expectOne('/api/tasks/awaiting-task').flush(awaitingTaskDetail);

    const component = fixture.componentInstance as unknown as {
      answerControl: { setValue: (value: string) => void };
      reasonControl: { setValue: (value: string) => void };
      confirmAnswerResume: () => void;
      submitPendingCommand: () => void;
    };
    component.answerControl.setValue('Use v2.');
    component.confirmAnswerResume();
    component.reasonControl.setValue('Answer supplied.');
    component.submitPendingCommand();

    const answer = http.expectOne('/api/tasks/awaiting-task/answers');
    expect(answer.request.body).toEqual(
      jasmine.objectContaining({
        questionId: 'question-1',
        body: 'Use v2.',
        command: jasmine.objectContaining({ type: 'resume' }),
      }),
    );
    answer.flush({
      task: {
        ...awaitingTaskDetail.task,
        status: 'ready',
        humanAnswers: [
          {
            id: 'answer-1',
            questionId: 'question-1',
            body: 'Use v2.',
            createdAt: '2026-04-29T08:01:00.000Z',
          },
        ],
      },
    });
    http.expectOne('/api/tasks/awaiting-task').flush({
      ...awaitingTaskDetail,
      task: { ...awaitingTaskDetail.task, status: 'ready' },
      summary: { ...awaitingTaskDetail.summary, status: 'ready' },
    });
  });

  it('requires a reason before posting risky operator commands', async () => {
    const http = await configure([TaskDetailPanelComponent]);
    loadSession(http, operatorSession);

    const fixture = TestBed.createComponent(TaskDetailPanelComponent);
    fixture.componentRef.setInput('taskId', 'ready-task');
    http.expectOne('/api/tasks/ready-task').flush(readyTaskDetail);

    const holdPolicy = TASK_COMMAND_POLICIES.find((policy) => policy.command === 'hold');
    expect(holdPolicy).toBeDefined();
    const component = fixture.componentInstance as unknown as {
      openCommand: (policy: NonNullable<typeof holdPolicy>) => void;
      submitPendingCommand: () => void;
    };
    component.openCommand(holdPolicy!);
    component.submitPendingCommand();

    http.expectNone('/api/tasks/ready-task/commands/hold');
  });
});

describe('CreateTaskPageComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('validates required fields and sends ready status only for create-ready', async () => {
    const http = await configure([CreateTaskPageComponent]);
    loadSession(http, developerSession);
    const router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);

    const fixture = TestBed.createComponent(CreateTaskPageComponent);
    const component = fixture.componentInstance as unknown as {
      form: {
        patchValue: (value: Record<string, unknown>) => void;
      };
      createReady: () => void;
      openPreview: () => void;
    };

    component.createReady();
    http.expectNone('/api/tasks');

    component.form.patchValue({
      title: 'Create workflow UI',
      description: 'Build the workflow UI.',
      tags: 'ai_dev,frontend',
      acceptanceCriteria: 'Ready task is created.',
    });
    component.openPreview();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('generated from the current form values');

    component.createReady();
    const create = http.expectOne('/api/tasks');
    expect(create.request.body).toEqual(
      jasmine.objectContaining({
        title: 'Create workflow UI',
        description: 'Build the workflow UI.',
        status: 'ready',
        tags: ['ai_dev', 'frontend'],
        acceptanceCriteria: ['Ready task is created.'],
      }),
    );
    create.flush({ task: readyTaskDetail.task, idempotent: false });
    expect(router.navigate).toHaveBeenCalledWith(['/', readyTaskDetail.task.id]);
  });
});

describe('ProposalsPageComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('approves and rejects proposed items with required review reasons', async () => {
    const http = await configure([ProposalsPageComponent]);
    loadSession(http, developerSession);

    const fixture = TestBed.createComponent(ProposalsPageComponent);
    fixture.detectChanges();
    http.expectOne((entry) => entry.url === '/api/proposals' && entry.params.get('supervisorStatus') === 'proposed').flush({
      proposals: [proposedTask],
      role: 'developer',
      generatedAt: '2026-04-29T08:00:00.000Z',
    });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Runbook explains the flaky test flow.');

    const component = fixture.componentInstance as unknown as {
      reasonControl: { setValue: (value: string) => void };
      openAction: (proposal: typeof proposedTask, command: 'approve-proposal' | 'reject-proposal') => void;
      submitAction: () => void;
    };
    component.openAction(proposedTask, 'approve-proposal');
    component.submitAction();
    http.expectNone('/api/tasks/proposal-task/commands/approve-proposal');

    component.reasonControl.setValue('Safe documentation task.');
    component.submitAction();
    const approve = http.expectOne('/api/tasks/proposal-task/commands/approve-proposal');
    expect(approve.request.body).toEqual({ reason: 'Safe documentation task.' });
    approve.flush({ task: { ...readyTaskDetail.task, id: 'proposal-task' } });
    http.expectOne((entry) => entry.url === '/api/proposals').flush({
      proposals: [],
      role: 'developer',
      generatedAt: '2026-04-29T08:01:00.000Z',
    });
  });
});
