import { OperationTaskDiagnosticDto, TaskSummaryDto } from '../models/human-api.dto';
import { operationsSnapshot } from '../testing/human-api.fixtures';
import { buildOperationsAttention } from './operations-page.component';

const waitingTask = (id: string, updatedAt: string): TaskSummaryDto => ({
  id,
  title: id,
  status: 'awaiting_human',
  updatedAt,
});

const questionDiagnostic = (
  task: TaskSummaryDto,
  createdAt: string,
): OperationTaskDiagnosticDto => ({
  taskId: task.id,
  latestQuestion: { id: `question-${task.id}`, createdAt },
  failedAgentRuns: 0,
  repeatedValidationFailures: 0,
  recentEvents: [],
  updatedAt: task.updatedAt,
});

describe('buildOperationsAttention', () => {
  it('deduplicates actionable repeats and keeps recovered tasks in history', () => {
    const failed = operationsSnapshot.failedTasks[0];
    const waiting = operationsSnapshot.waitingForHuman[0];
    const blocked = { ...failed, id: 'blocked-task', status: 'blocked' as const };
    const recovered = { ...failed, id: 'recovered-task', status: 'ready' as const };
    const completed = { ...failed, id: 'completed-task', status: 'done' as const };
    const result = buildOperationsAttention(
      { ...operationsSnapshot, repeatedFailures: [failed, waiting, blocked, recovered, completed, completed] },
      new Map(),
    );

    expect(result.rows.map(({ task }) => task.id)).toEqual([waiting.id, blocked.id, failed.id]);
    expect(result.rows.every(({ repeated }) => repeated)).toBeTrue();
    expect(result.history.map(({ id }) => id)).toEqual([completed.id, recovered.id]);
  });

  it('orders by the first open question, falling back to the latest question or a marked estimate', () => {
    const oldest = waitingTask('oldest-question', '2026-04-29T07:55:00Z');
    const recent = waitingTask('recent-question', '2026-04-29T07:05:00Z');
    const fallback = waitingTask('fallback-question', '2026-04-29T07:20:00Z');
    const unknown = waitingTask('unknown-question', '');
    const oldestQuestionAt = '2026-04-29T07:10:00Z';
    const diagnostics = new Map([
      [oldest.id, {
        ...questionDiagnostic(oldest, '2026-04-29T07:40:00Z'),
        waitingSince: oldestQuestionAt,
      }],
      [recent.id, {
        ...questionDiagnostic(recent, '2026-04-29T07:30:00Z'),
        waitingSince: 'invalid',
      }],
      [fallback.id, questionDiagnostic(fallback, 'invalid')],
    ]);
    const result = buildOperationsAttention(
      {
        ...operationsSnapshot,
        waitingForHuman: [recent, unknown, fallback, oldest],
        failedTasks: [],
        repeatedFailures: [],
      },
      diagnostics,
    );

    expect(result.rows.map(({ task }) => task.id)).toEqual([oldest.id, fallback.id, recent.id, unknown.id]);
    expect(result.rows.map(({ waitingAgeIsApproximate }) => waitingAgeIsApproximate)).toEqual([false, true, false, true]);
    expect(result.rows[0].waitingSince).toBe(Date.parse(oldestQuestionAt));
    expect(result.rows[1].waitingSince).toBe(Date.parse(fallback.updatedAt));
    expect(result.rows[3].waitingSince).toBeUndefined();
  });
});
