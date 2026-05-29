import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Provider } from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import Aura from '@primeuix/themes/aura';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';

import { TaskDetailPanelComponent } from '../components/task-detail-panel.component';
import { ProjectGoalDto } from '../models/human-api.dto';
import { SessionService } from '../services/session.service';
import {
  TASK_COMMAND_POLICIES,
  TASK_STATUSES,
  projectConfidenceLabel,
  projectGoalPriorityLabel,
  projectGoalRiskLabel,
  projectGoalStatusLabel,
  projectStrategyArchitectVerdictLabel,
  projectStrategyDimensionLabel,
  projectStrategyNextStepLabel,
  statusLabel,
} from '../utils/task-ui';
import { CreateTaskPageComponent } from './create-task-page.component';
import { GoalDetailPageComponent } from './goal-detail-page.component';
import { GoalsPageComponent } from './goals-page.component';
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
  approvedProjectGoal,
  mrValidationTaskDetail,
  operationsSnapshot,
  operatorSession,
  projectGoal,
  projectGoalDetail,
  projectGoalList,
  proposedTask,
  readyTask,
  readyTaskDetail,
  viewerSession,
} from '../testing/human-api.fixtures';

const configure = async (imports: unknown[], providers: Provider[] = []): Promise<HttpTestingController> => {
  await TestBed.configureTestingModule({
    imports,
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideAnimationsAsync(),
      providePrimeNG({ theme: { preset: Aura } }),
      MessageService,
      ...providers,
    ],
  }).compileComponents();
  return TestBed.inject(HttpTestingController);
};

const loadSession = (http: HttpTestingController, session = developerSession): void => {
  TestBed.inject(SessionService).load();
  http.expectOne('/api/session').flush(session);
};

const pmViewerSession = {
  ...viewerSession,
  capabilities: {
    ...viewerSession.capabilities,
    canReadProjectGoals: true,
  },
};

const pmDeveloperSession = {
  ...developerSession,
  capabilities: {
    ...developerSession.capabilities,
    canReadProjectGoals: true,
    canApproveProjectGoals: true,
    canCompleteProjectGoals: true,
    canMarkProjectGoalsStale: true,
  },
};

const pmOperatorSession = {
  ...operatorSession,
  capabilities: {
    ...operatorSession.capabilities,
    canReadProjectGoals: true,
    canApproveProjectGoals: true,
    canProposeProjectGoalTasks: true,
    canCompleteProjectGoals: true,
    canMarkProjectGoalsStale: true,
    canRunProjectManager: true,
  },
};

const routeProvider = (goalId = projectGoal.id): Provider => ({
  provide: ActivatedRoute,
  useValue: {
    snapshot: {
      paramMap: convertToParamMap({ goalId }),
    },
  },
});

const goalDetailWith = (goal: ProjectGoalDto) => ({
  ...projectGoalDetail,
  goal,
});

describe('task UI labels', () => {
  it('renders Russian task status and command labels', () => {
    expect(statusLabel('ready')).toBe('Готова');
    expect(statusLabel('awaiting_human')).toBe('Ждет человека');
    expect(statusLabel('human_testing')).toBe('Тестируется человеком');
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

  it('renders localized project manager labels', () => {
    expect(projectGoalStatusLabel('approved')).toBe('Одобрено');
    expect(projectGoalPriorityLabel('critical')).toBe('Критический');
    expect(projectGoalRiskLabel('medium')).toBe('Средний');
    expect(projectStrategyDimensionLabel('product_technical')).toBe('Продукт и техника');
    expect(projectStrategyNextStepLabel('create_goal')).toBe('Создать цель');
    expect(projectStrategyArchitectVerdictLabel('research_first')).toBe('Сначала исследовать');
    expect(projectConfidenceLabel(82)).toBe('Уверенность: 82%');
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

  it('renders linked parent project goals in task details', async () => {
    const http = await configure([TaskDetailPanelComponent]);
    loadSession(http, viewerSession);

    const fixture = TestBed.createComponent(TaskDetailPanelComponent);
    fixture.componentRef.setInput('taskId', 'ready-task');
    http.expectOne('/api/tasks/ready-task').flush({
      ...readyTaskDetail,
      projectGoals: [projectGoal],
    });
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const text = element.textContent ?? '';
    expect(text).toContain('Цели проекта');
    expect(text).toContain(projectGoal.title);
    expect(element.querySelector(`a[href="/goals/${projectGoal.id}"]`)).not.toBeNull();
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

  it('renders linked parent project goals for proposal responses', async () => {
    const http = await configure([ProposalsPageComponent]);
    loadSession(http, viewerSession);

    const fixture = TestBed.createComponent(ProposalsPageComponent);
    fixture.detectChanges();
    http.expectOne((entry) => entry.url === '/api/proposals' && entry.params.get('supervisorStatus') === 'proposed').flush({
      proposals: [
        {
          ...proposedTask,
          projectGoals: [projectGoal],
        },
      ],
      role: 'viewer',
      generatedAt: '2026-04-29T08:00:00.000Z',
    });
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain(projectGoal.title);
    expect(element.querySelector(`a[href="/goals/${projectGoal.id}"]`)).not.toBeNull();
  });
});

describe('GoalsPageComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders project goals with the default proposed filter and linked task counts', async () => {
    const http = await configure([GoalsPageComponent]);
    loadSession(http, pmOperatorSession);

    const fixture = TestBed.createComponent(GoalsPageComponent);
    fixture.detectChanges();
    const request = http.expectOne((entry) => entry.url === '/api/project-goals' && entry.params.get('status') === 'proposed');
    expect(request.request.params.has('repositoryName')).toBeFalse();
    request.flush(projectGoalList);
    http.expectOne('/api/project-manager/analyses?analysisKind=strategy').flush({ analyses: [] });
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Цели проекта');
    expect(text).toContain(projectGoal.title);
    expect(text).toContain(projectGoal.id);
    expect(text).toContain('developer');
    expect(text).toContain('Связанные задачи');
    expect(text).toContain('Черновики задач');
    expect(text).toContain('1');
    expect(text).toContain('run-1');
    expect(text).toContain('PM analysis found missing traceability.');
    expect((fixture.nativeElement as HTMLElement).querySelector(`a[href="/goals/${projectGoal.id}"]`)).not.toBeNull();
  });

  it('lets operators run strategy mode and renders latest strategy opportunities', async () => {
    const now = '2026-04-29T08:00:00.000Z';
    const http = await configure([GoalsPageComponent]);
    loadSession(http, pmOperatorSession);

    const fixture = TestBed.createComponent(GoalsPageComponent);
    fixture.detectChanges();

    http.expectOne('/api/project-goals?status=proposed').flush({
      goals: [],
      linkedTaskCounts: {},
      role: 'operator',
      generatedAt: now,
    });
    http.expectOne('/api/project-manager/analyses?analysisKind=strategy').flush({
      analyses: [
        {
          id: 'pm_analysis_strategy',
          repositoryName: 'developer',
          analysisKind: 'strategy',
          summary: 'Strategy summary.',
          strategy: {
            summary: 'Strategy summary.',
            analysisLenses: [{ lens: 'strategy', summary: 'Focus on validation trust.' }],
            opportunities: [
              {
                opportunityId: 'opp-1',
                dimension: 'technical',
                title: 'Improve validation trust',
                problemStatement: 'Weak evidence.',
                userOrBusinessImpact: 'Operators lose confidence.',
                technicalImpact: 'Quality signals are weak.',
                evidenceRefs: [],
                confidence: 80,
                priority: 'high',
                riskLevel: 'medium',
                recommendedNextStep: 'create_goal',
                rationale: 'Supported.',
                redTeamNotes: ['Keep scope narrow.'],
                architectVerdict: 'pursue',
              },
            ],
            goalLinks: [
              {
                sourceOpportunityId: 'opp-1',
                proposedGoalTitle: 'Improve validation trust',
                evidenceRefs: [],
              },
            ],
            questionsForHuman: [],
          },
          createdAt: now,
        },
      ],
    });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Improve validation trust');

    const brief = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      '[data-testid="goals-strategy-brief"]',
    )!;
    brief.value = 'Focus on operator confidence.';
    brief.dispatchEvent(new Event('input'));
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-testid="goals-run-strategy"]')!.click();

    const request = http.expectOne('/api/project-manager/runs');
    expect(request.request.body).toEqual({
      repositoryName: 'developer',
      mode: 'strategy',
      strategyBrief: 'Focus on operator confidence.',
    });
  });

  it('requests goals with repository and status filters and can run analysis for operators', async () => {
    const http = await configure([GoalsPageComponent]);
    loadSession(http, pmOperatorSession);

    const fixture = TestBed.createComponent(GoalsPageComponent);
    fixture.detectChanges();
    http.expectOne((entry) => entry.url === '/api/project-goals' && entry.params.get('status') === 'proposed').flush(projectGoalList);
    http.expectOne('/api/project-manager/analyses?analysisKind=strategy').flush({ analyses: [] });

    const component = fixture.componentInstance as unknown as {
      repositoryFilter: { setValue: (value: string) => void };
      statusFilter: { setValue: (value: string) => void };
      load: () => void;
      runAnalysis: () => void;
    };
    component.repositoryFilter.setValue('developer');
    component.statusFilter.setValue('approved');
    component.load();
    const filtered = http.expectOne((entry) => entry.url === '/api/project-goals');
    expect(filtered.request.params.get('repositoryName')).toBe('developer');
    expect(filtered.request.params.get('status')).toBe('approved');
    filtered.flush({ ...projectGoalList, goals: [approvedProjectGoal] });
    http.expectOne('/api/project-manager/analyses?repositoryName=developer&analysisKind=strategy').flush({ analyses: [] });

    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="goals-run-analysis"]')).not.toBeNull();
    component.runAnalysis();
    const run = http.expectOne('/api/project-manager/runs');
    expect(run.request.body).toEqual({ repositoryName: 'developer' });
    run.flush({ runId: 'run-2' });
    http.expectOne((entry) => entry.url === '/api/project-goals' && entry.params.get('repositoryName') === 'developer').flush(projectGoalList);
    http.expectOne('/api/project-manager/analyses?repositoryName=developer&analysisKind=strategy').flush({ analyses: [] });
  });
});

describe('GoalDetailPageComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('loads and renders project goal detail traceability sections', async () => {
    const http = await configure([GoalDetailPageComponent], [routeProvider()]);
    loadSession(http, pmOperatorSession);

    const fixture = TestBed.createComponent(GoalDetailPageComponent);
    fixture.detectChanges();
    http.expectOne(`/api/project-goals/${projectGoal.id}`).flush(projectGoalDetail);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain(projectGoal.title);
    expect(text).toContain('Proposal review lacks goal traceability');
    expect(text).toContain('Reviewers can see the project goal');
    expect(text).toContain('Goal context appears on proposal');
    expect(text).toContain('PM analysis found missing traceability.');
    expect(text).toContain('Show project goal context in proposals');
    expect(text).toContain(readyTask.title);
    expect(text).toContain('Project goal proposed.');
  });

  it('renders replan audit details and lets operators run a goal replan with a required reason', async () => {
    const http = await configure([GoalDetailPageComponent], [routeProvider()]);
    loadSession(http, pmOperatorSession);

    const fixture = TestBed.createComponent(GoalDetailPageComponent);
    fixture.detectChanges();
    http.expectOne(`/api/project-goals/${projectGoal.id}`).flush({
      ...projectGoalDetail,
      auditEvents: [
        ...projectGoalDetail.auditEvents,
        {
          id: 'goal-event-replan-1',
          goalId: projectGoal.id,
          kind: 'project_goal_replan_classified',
          actor: { owner: 'agent', id: 'pm-agent', displayName: 'Project Manager' },
          message: 'Replan classified.',
          payload: {
            decision: 'create_follow_up',
            rationale: 'Linked task failed.',
          },
          createdAt: '2026-04-29T08:02:00.000Z',
        },
      ],
    });
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const text = element.textContent ?? '';
    expect(text).toContain('create_follow_up');
    expect(text).toContain('Linked task failed.');

    element.querySelector<HTMLButtonElement>('[data-testid="goal-run-replan"]')?.click();
    fixture.detectChanges();

    element.querySelector<HTMLButtonElement>('[data-testid="goal-replan-confirm"]')?.click();
    http.expectNone('/api/project-manager/runs');

    const reason = element.querySelector<HTMLTextAreaElement>('[data-testid="goal-replan-reason"]');
    expect(reason).not.toBeNull();
    reason!.value = 'manual: failed linked task';
    reason!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    element.querySelector<HTMLButtonElement>('[data-testid="goal-replan-confirm"]')?.click();
    const run = http.expectOne('/api/project-manager/runs');
    expect(run.request.body).toEqual({
      repositoryName: 'developer',
      mode: 'replan',
      replanReason: 'manual: failed linked task',
    });
    run.flush({ runId: 'run-replan-1', accepted: true });
    http.expectOne(`/api/project-goals/${projectGoal.id}`).flush(projectGoalDetail);
  });

  it('approves proposed goals and refreshes the detail', async () => {
    const http = await configure([GoalDetailPageComponent], [routeProvider()]);
    loadSession(http, pmDeveloperSession);

    const fixture = TestBed.createComponent(GoalDetailPageComponent);
    fixture.detectChanges();
    http.expectOne(`/api/project-goals/${projectGoal.id}`).flush(projectGoalDetail);
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-testid="goal-approve"]')?.click();
    const approve = http.expectOne(`/api/project-goals/${projectGoal.id}/commands/approve`);
    expect(approve.request.body).toEqual({});
    approve.flush({ goal: approvedProjectGoal });
    http.expectOne(`/api/project-goals/${projectGoal.id}`).flush(goalDetailWith(approvedProjectGoal));
  });

  it('requires a reject reason before posting and submits non-empty reasons', async () => {
    const http = await configure([GoalDetailPageComponent], [routeProvider()]);
    loadSession(http, pmDeveloperSession);

    const fixture = TestBed.createComponent(GoalDetailPageComponent);
    fixture.detectChanges();
    http.expectOne(`/api/project-goals/${projectGoal.id}`).flush(projectGoalDetail);
    fixture.detectChanges();

    const component = fixture.componentInstance as unknown as {
      reasonControl: { setValue: (value: string) => void };
      openReasonDialog: (action: 'reject' | 'stale') => void;
      submitReasonAction: () => void;
    };
    component.openReasonDialog('reject');
    component.submitReasonAction();
    http.expectNone(`/api/project-goals/${projectGoal.id}/commands/reject`);

    component.reasonControl.setValue('No longer matches roadmap.');
    component.submitReasonAction();
    const reject = http.expectOne(`/api/project-goals/${projectGoal.id}/commands/reject`);
    expect(reject.request.body).toEqual({ reason: 'No longer matches roadmap.' });
    reject.flush({ goal: { ...projectGoal, status: 'rejected', rejectionReason: 'No longer matches roadmap.' } });
    http.expectOne(`/api/project-goals/${projectGoal.id}`).flush(
      goalDetailWith({ ...projectGoal, status: 'rejected', rejectionReason: 'No longer matches roadmap.' }),
    );
  });

  it('lets operators propose tasks for approved goals', async () => {
    const http = await configure([GoalDetailPageComponent], [routeProvider(approvedProjectGoal.id)]);
    loadSession(http, pmOperatorSession);

    const fixture = TestBed.createComponent(GoalDetailPageComponent);
    fixture.detectChanges();
    http.expectOne(`/api/project-goals/${approvedProjectGoal.id}`).flush(goalDetailWith(approvedProjectGoal));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="goal-propose-tasks"]')).not.toBeNull();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-testid="goal-propose-tasks"]')?.click();
    const propose = http.expectOne(`/api/project-goals/${approvedProjectGoal.id}/commands/propose-tasks`);
    expect(propose.request.body).toEqual({});
    propose.flush({ goal: approvedProjectGoal, tasks: [], proposals: [], taskLinks: [] });
    http.expectOne(`/api/project-goals/${approvedProjectGoal.id}`).flush(goalDetailWith(approvedProjectGoal));
  });

  it('lets developers complete active goals', async () => {
    const activeGoal: ProjectGoalDto = { ...projectGoal, status: 'active', activatedAt: '2026-04-29T08:05:00.000Z' };
    const completedGoal: ProjectGoalDto = { ...activeGoal, status: 'completed', completedAt: '2026-04-29T08:10:00.000Z' };
    const http = await configure([GoalDetailPageComponent], [routeProvider(activeGoal.id)]);
    loadSession(http, pmDeveloperSession);

    const fixture = TestBed.createComponent(GoalDetailPageComponent);
    fixture.detectChanges();
    http.expectOne(`/api/project-goals/${activeGoal.id}`).flush(goalDetailWith(activeGoal));
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-testid="goal-complete"]')?.click();
    const complete = http.expectOne(`/api/project-goals/${activeGoal.id}/commands/complete`);
    expect(complete.request.body).toEqual({});
    complete.flush({ goal: completedGoal });
    http.expectOne(`/api/project-goals/${activeGoal.id}`).flush(goalDetailWith(completedGoal));
  });

  it('requires a stale reason before posting and submits non-empty reasons', async () => {
    const http = await configure([GoalDetailPageComponent], [routeProvider()]);
    loadSession(http, pmDeveloperSession);

    const fixture = TestBed.createComponent(GoalDetailPageComponent);
    fixture.detectChanges();
    http.expectOne(`/api/project-goals/${projectGoal.id}`).flush(projectGoalDetail);
    fixture.detectChanges();

    const component = fixture.componentInstance as unknown as {
      reasonControl: { setValue: (value: string) => void };
      openReasonDialog: (action: 'reject' | 'stale') => void;
      submitReasonAction: () => void;
    };
    component.openReasonDialog('stale');
    component.submitReasonAction();
    http.expectNone(`/api/project-goals/${projectGoal.id}/commands/stale`);

    component.reasonControl.setValue('Superseded by newer analysis.');
    component.submitReasonAction();
    const stale = http.expectOne(`/api/project-goals/${projectGoal.id}/commands/stale`);
    expect(stale.request.body).toEqual({ reason: 'Superseded by newer analysis.' });
    stale.flush({ goal: { ...projectGoal, status: 'stale', staleReason: 'Superseded by newer analysis.' } });
    http.expectOne(`/api/project-goals/${projectGoal.id}`).flush(
      goalDetailWith({ ...projectGoal, status: 'stale', staleReason: 'Superseded by newer analysis.' }),
    );
  });

  it('hides goal mutation actions for viewer sessions', async () => {
    const http = await configure([GoalDetailPageComponent], [routeProvider()]);
    loadSession(http, pmViewerSession);

    const fixture = TestBed.createComponent(GoalDetailPageComponent);
    fixture.detectChanges();
    http.expectOne(`/api/project-goals/${projectGoal.id}`).flush(projectGoalDetail);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid="goal-approve"]')).toBeNull();
    expect(element.querySelector('[data-testid="goal-reject"]')).toBeNull();
    expect(element.querySelector('[data-testid="goal-propose-tasks"]')).toBeNull();
    expect(element.querySelector('[data-testid="goal-complete"]')).toBeNull();
    expect(element.querySelector('[data-testid="goal-stale"]')).toBeNull();
    expect(element.querySelector('[data-testid="goal-run-analysis"]')).toBeNull();
    expect(element.querySelector('[data-testid="goal-run-replan"]')).toBeNull();
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
