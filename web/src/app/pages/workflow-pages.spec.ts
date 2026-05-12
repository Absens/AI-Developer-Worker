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
import { TASK_COMMAND_POLICIES, TASK_STATUSES, statusLabel } from '../utils/task-ui';
import { CreateTaskPageComponent } from './create-task-page.component';
import {
  OperationsPageComponent,
  classifyHeartbeat,
  heartbeatAgeSeconds,
} from './operations-page.component';
import { ProposalsPageComponent } from './proposals-page.component';
import { QueuePageComponent } from './queue-page.component';
import {
  awaitingTaskDetail,
  blockedTask,
  developerSession,
  draftTask,
  failedTask,
  mrValidationTaskDetail,
  operationsSnapshot,
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

describe('task UI labels', () => {
  it('renders Russian task status and command labels', () => {
    expect(statusLabel('ready')).toBe('Готова');
    expect(statusLabel('awaiting_human')).toBe('Ждет человека');
    expect(statusLabel('fixing_review')).toBe('Исправление ревью');
    expect(statusLabel('codex_agent_message')).toBe('Сообщение Codex');
    expect(statusLabel('codex_command_progress')).toBe('Codex выполняется');
    expect(TASK_COMMAND_POLICIES.map((policy) => policy.label)).toEqual([
      'В готовые',
      'Возобновить',
      'Отменить',
      'Поставить на паузу',
      'Повторить',
      'Переанализировать',
    ]);
  });
});

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
    expect(text).toContain('Готова');
    expect(text).toContain('Ждет человека');
    expect(text).toContain('Ошибка');
    expect(text).toContain('Implement ready queue item');
    expect(text).toContain('Need API decision');
    expect(text).toContain('Выберите задачу');
  });

  it('renders a queue group for every known task status', async () => {
    const http = await configure([QueuePageComponent]);
    loadSession(http, viewerSession);

    const fixture = TestBed.createComponent(QueuePageComponent);
    fixture.detectChanges();

    http.expectOne((entry) => entry.url === '/api/tasks').flush({
      tasks: [readyTask],
      role: 'viewer',
      generatedAt: '2026-04-29T08:00:00.000Z',
    });
    fixture.detectChanges();

    const groups = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.surface.queue-group')];
    expect(groups.length).toBe(TASK_STATUSES.length);
    expect(groups.map((group) => group.querySelector('h2')?.textContent?.trim())).toEqual(
      TASK_STATUSES.map(statusLabel),
    );
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
    expect(text).toContain('Отменить');
  });

  it('hides mutation actions for a viewer session', async () => {
    const http = await configure([TaskDetailPanelComponent]);
    loadSession(http, viewerSession);

    const fixture = TestBed.createComponent(TaskDetailPanelComponent);
    fixture.componentRef.setInput('taskId', 'ready-task');
    http.expectOne('/api/tasks/ready-task').flush(readyTaskDetail);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Предпросмотр контекста');
    expect(text).not.toContain('Отменить');
    expect(text).not.toContain('Поставить на паузу');
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
    expect(text).toContain('ID задачи');
    expect(text).toContain('ready-task');
    expect(text).toContain('Критерии приемки');
    expect(text).toContain('События');
  });

  it('polls active task details and keeps draft answer input while rendering Codex timeline events', async () => {
    const http = await configure([TaskDetailPanelComponent]);
    loadSession(http, developerSession);
    jasmine.clock().install();

    try {
      const fixture = TestBed.createComponent(TaskDetailPanelComponent);
      fixture.componentRef.setInput('taskId', 'awaiting-task');
      http.expectOne('/api/tasks/awaiting-task').flush(awaitingTaskDetail);
      fixture.detectChanges();

      const component = fixture.componentInstance as unknown as {
        answerControl: { setValue: (value: string) => void; value: string };
      };
      component.answerControl.setValue('Draft answer in progress.');

      jasmine.clock().tick(15_000);
      http.expectOne('/api/tasks/awaiting-task').flush({
        ...awaitingTaskDetail,
        task: {
          ...awaitingTaskDetail.task,
          events: [
            ...awaitingTaskDetail.task.events,
            {
              id: 'codex-progress-1',
              kind: 'codex_agent_message',
              source: 'worker_agent',
              message: 'Running project tests.',
              createdAt: '2026-04-29T08:01:00.000Z',
            },
          ],
        },
      });
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Сообщение Codex');
      expect(text).toContain('Running project tests.');
      expect(component.answerControl.value).toBe('Draft answer in progress.');

      fixture.destroy();
    } finally {
      jasmine.clock().uninstall();
    }
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
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('сформирован из текущих значений формы');

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

describe('OperationsPageComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('classifies worker heartbeat age with Phase 8C thresholds', async () => {
    await configure([]);
    const generatedAt = '2026-04-29T08:00:00.000Z';

    expect(
      heartbeatAgeSeconds(
        { workerId: 'worker-1', state: 'idle', lastHeartbeatAt: '2026-04-29T07:59:30.000Z' },
        generatedAt,
      ),
    ).toBe(30);
    expect(
      classifyHeartbeat(
        { workerId: 'worker-1', state: 'idle', lastHeartbeatAt: '2026-04-29T07:59:30.000Z' },
        generatedAt,
      ),
    ).toBe('healthy');
    expect(
      classifyHeartbeat(
        { workerId: 'worker-1', state: 'idle', lastHeartbeatAt: '2026-04-29T07:58:00.000Z' },
        generatedAt,
      ),
    ).toBe('warning');
    expect(
      classifyHeartbeat(
        { workerId: 'worker-1', state: 'idle', lastHeartbeatAt: '2026-04-29T07:54:00.000Z' },
        generatedAt,
      ),
    ).toBe('error');
  });

  it('renders overview counters, worker heartbeats, leases, queue depth, and task links', async () => {
    const http = await configure([OperationsPageComponent]);
    loadSession(http, operatorSession);

    const fixture = TestBed.createComponent(OperationsPageComponent);
    fixture.detectChanges();
    http.expectOne('/api/operations').flush(operationsSnapshot);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const text = element.textContent ?? '';
    expect(text).toContain('Активные воркеры');
    expect(text).toContain('Готовая очередь');
    expect(text).toContain('Пульс воркеров');
    expect(text).toContain('worker-1');
    expect(text).toContain('В норме');
    expect(text).toContain('Активные аренды');
    expect(text).toContain('lease-1');
    expect(text).toContain('Глубина очереди');
    expect(text).toContain('normal');
    expect(text).toContain('Задачи с ошибкой');
    expect(text).toContain('Повторить');
    expect(text).toContain('Поставить на паузу');
    expect([...element.querySelectorAll('a')].some((anchor) => anchor.textContent?.includes('awaiting-task'))).toBeTrue();
  });

  it('renders failed task diagnostics from allowlisted operations fields', async () => {
    const http = await configure([OperationsPageComponent]);
    loadSession(http, operatorSession);

    const fixture = TestBed.createComponent(OperationsPageComponent);
    fixture.detectChanges();
    http.expectOne('/api/operations').flush(operationsSnapshot);

    (fixture.componentInstance as unknown as { openDiagnostics: (task: typeof failedTask) => void }).openDiagnostics(failedTask);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Детали диагностики');
    expect(text).toContain('Unit tests failed.');
    expect(text).toContain('Codex implementation failed');
    expect(text).toContain('Последние события жизненного цикла');
    expect(text).toContain('Validation failed.');
  });

  it('renders waiting-for-human tasks with approximate waiting duration and answer links', async () => {
    const http = await configure([OperationsPageComponent]);
    loadSession(http, operatorSession);

    const fixture = TestBed.createComponent(OperationsPageComponent);
    fixture.detectChanges();
    http.expectOne('/api/operations').flush(operationsSnapshot);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Ждет человека');
    expect(text).toContain('Need API choice.');
    expect(text).toContain('Примерно');
    expect(text).toContain('Ответить');
  });

  it('preserves the last snapshot and marks it stale after a manual refresh failure', async () => {
    const http = await configure([OperationsPageComponent]);
    loadSession(http, operatorSession);

    const fixture = TestBed.createComponent(OperationsPageComponent);
    fixture.detectChanges();
    http.expectOne('/api/operations').flush(operationsSnapshot);
    fixture.detectChanges();

    const refresh = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[aria-label="Обновить операции"]',
    );
    expect(refresh).not.toBeNull();
    refresh?.click();
    fixture.detectChanges();

    http.expectOne('/api/operations').flush(
      { status: 'error', error: 'backend unavailable' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('worker-1');
    expect(text).toContain('Показан последний успешный снимок');
    expect(text).toContain('backend unavailable');
  });

  it('hides retry and hold actions for viewer sessions', async () => {
    const http = await configure([OperationsPageComponent]);
    loadSession(http, viewerSession);

    const fixture = TestBed.createComponent(OperationsPageComponent);
    fixture.detectChanges();
    http.expectOne('/api/operations').flush(operationsSnapshot);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Повторить');
    expect(text).not.toContain('Поставить на паузу');
    expect(text).toContain('Детали');
  });
});
