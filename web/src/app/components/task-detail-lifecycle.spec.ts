import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter } from '@angular/router';
import Aura from '@primeuix/themes/aura';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';

import { SessionDto, TaskStatusDto } from '../models/human-api.dto';
import { SessionService } from '../services/session.service';
import { developerSession, readyTaskDetail, viewerSession } from '../testing/human-api.fixtures';
import { TaskDetailPanelComponent } from './task-detail-panel.component';

const acceptanceSession: SessionDto = {
  ...developerSession,
  capabilities: { ...developerSession.capabilities, canAcceptTask: true },
};

const atStatus = (status: TaskStatusDto, revisionNumber: number | null = 2) => {
  const summary = { ...readyTaskDetail.summary, status };
  return {
    ...readyTaskDetail,
    summary,
    task: {
      ...readyTaskDetail.task,
      ...summary,
      description: 'Описание исходной задачи',
      acceptanceCriteria: ['Первый критерий'],
      mergeRequestUrl: 'https://gitlab.test/team/demo/-/merge_requests/1',
      revisions: revisionNumber === null ? [] : [{ revisionNumber }],
    },
  };
};

describe('Task detail lifecycle', () => {
  let fixture: ComponentFixture<TaskDetailPanelComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TaskDetailPanelComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideAnimationsAsync('noop'),
        providePrimeNG({ theme: { preset: Aura } }),
        MessageService,
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const showTask = (status: TaskStatusDto, session = developerSession, revisionNumber: number | null = 2): void => {
    TestBed.inject(SessionService).load();
    http.expectOne('/api/session').flush(session);
    fixture = TestBed.createComponent(TaskDetailPanelComponent);
    fixture.componentRef.setInput('taskId', readyTaskDetail.task.id);
    http.expectOne(`/api/tasks/${readyTaskDetail.task.id}`).flush(atStatus(status, revisionNumber));
    fixture.detectChanges();
  };

  const query = <T extends HTMLElement>(testId: string): T | null =>
    (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);

  const fieldValue = (testId: string, value: string): void => {
    const field = query<HTMLInputElement | HTMLTextAreaElement>(testId)!;
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };

  it('edits the loaded revision and keeps input available if the draft changes elsewhere', () => {
    showTask('new');
    query<HTMLButtonElement>('edit-task-draft')!.click();
    fixture.detectChanges();
    expect(query<HTMLTextAreaElement>('draft-description')?.value).toBe('Описание исходной задачи');
    fieldValue('draft-description', 'Новое описание');
    fieldValue('draft-criteria', 'Первый критерий, включая запятую\nВторой критерий');
    query<HTMLButtonElement>('draft-save')!.click();
    const save = http.expectOne({
      url: `/api/tasks/${readyTaskDetail.task.id}/revisions`,
      method: 'POST',
    });
    expect(save.request.body).toEqual({
      title: readyTaskDetail.task.title,
      description: 'Новое описание',
      acceptanceCriteria: ['Первый критерий, включая запятую', 'Второй критерий'],
      expectedStatus: 'new',
      expectedRevisionNumber: 2,
    });
    save.flush({ error: 'Ревизия черновика изменилась.' }, { status: 409, statusText: 'Conflict' });
    http.expectOne(`/api/tasks/${readyTaskDetail.task.id}`).flush(atStatus('new', 3));
    fixture.detectChanges();
    expect(query('draft-stale')).not.toBeNull();
    expect(query<HTMLTextAreaElement>('draft-description')?.value).toBe('Новое описание');
    expect(query<HTMLButtonElement>('draft-save')?.disabled).toBeTrue();
  });

  it('requires the acceptance report and closes the task after confirmation', () => {
    showTask('human_testing', acceptanceSession);
    query<HTMLButtonElement>('command-accept-result')!.click();
    fixture.detectChanges();
    expect(query('command-dialog')?.textContent).toContain('Первый критерий');
    expect(query('command-dialog')?.querySelector('a')?.href)
      .toBe('https://gitlab.test/team/demo/-/merge_requests/1');
    expect(query<HTMLButtonElement>('command-confirm')?.disabled).toBeTrue();
    fieldValue('command-reason', '  Сценарий проверен.  ');
    query<HTMLButtonElement>('command-confirm')!.click();

    const accept = http.expectOne({
      url: `/api/tasks/${readyTaskDetail.task.id}/commands/accept-result`,
      method: 'POST',
    });
    expect(accept.request.body).toEqual({
      reason: 'Сценарий проверен.', expectedStatus: 'human_testing', expectedRevisionNumber: 2,
    });
    const accepted = atStatus('done');
    accept.flush({ task: accepted.task });
    fixture.detectChanges();
    expect(query('task-detail')?.textContent).toContain('Завершена');
    expect(query('command-accept-result')).toBeNull();
    http.expectOne(`/api/tasks/${readyTaskDetail.task.id}`).flush(accepted);
  });

  it('blocks retry against changed criteria after a conflict and preserves the acceptance report', () => {
    showTask('human_testing', acceptanceSession);
    query<HTMLButtonElement>('command-accept-result')!.click();
    fixture.detectChanges();
    fieldValue('command-reason', 'Сценарий проверен.');
    query<HTMLButtonElement>('command-confirm')!.click();
    http.expectOne(`/api/tasks/${readyTaskDetail.task.id}/commands/accept-result`).flush(
      { error: 'Ревизия задачи изменилась.' },
      { status: 409, statusText: 'Conflict' },
    );
    const refresh = http.expectOne(`/api/tasks/${readyTaskDetail.task.id}`);
    fixture.detectChanges();
    expect(query<HTMLButtonElement>('command-confirm')?.disabled).toBeTrue();
    const changed = atStatus('human_testing', 3);
    changed.task.acceptanceCriteria = ['Новый критерий'];
    refresh.flush(changed);
    fixture.detectChanges();
    expect(query('acceptance-stale')).not.toBeNull();
    expect(query<HTMLTextAreaElement>('command-reason')?.value).toBe('Сценарий проверен.');
    expect(query<HTMLButtonElement>('command-confirm')?.disabled).toBeTrue();
    query<HTMLButtonElement>('command-confirm')!.click();
    http.expectNone(`/api/tasks/${readyTaskDetail.task.id}/commands/accept-result`);

    query<HTMLButtonElement>('command-cancel')!.click();
    fixture.detectChanges();
    query<HTMLButtonElement>('command-accept-result')!.click();
    fixture.detectChanges();
    expect(query('command-dialog')?.textContent).toContain('Новый критерий');
    fieldValue('command-reason', 'Обновлённый критерий проверен.');
    query<HTMLButtonElement>('command-confirm')!.click();
    const accept = http.expectOne(`/api/tasks/${readyTaskDetail.task.id}/commands/accept-result`);
    expect(accept.request.body.expectedRevisionNumber).toBe(3);
    const accepted = atStatus('done', 3);
    accept.flush({ task: accepted.task });
    http.expectOne(`/api/tasks/${readyTaskDetail.task.id}`).flush(accepted);
  });

  it('hides acceptance without a current revision', () => {
    showTask('human_testing', acceptanceSession, null);
    expect(query('task-detail')?.textContent).toContain('Ожидает приёмки');
    expect(query('command-accept-result')).toBeNull();
  });

  it('keeps editing and approval actions out of a viewer session', () => {
    showTask('new', viewerSession);
    expect(query('edit-task-draft')).toBeNull();
    fixture.destroy();
    showTask('human_testing', viewerSession);
    expect(query('task-detail')?.textContent).toContain('Ожидает приёмки');
    expect(query('command-accept-result')).toBeNull();
  });
});
