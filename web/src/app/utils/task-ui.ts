import { SessionDto, TaskStatusDto } from '../models/human-api.dto';
import { TaskCommandName } from '../services/task-command.service';

export const TASK_STATUSES: TaskStatusDto[] = [
  'new',
  'triage',
  'ready',
  'claimed',
  'analyzing',
  'awaiting_human',
  'decomposing',
  'implementing',
  'validating',
  'review',
  'human_testing',
  'fixing_review',
  'blocked',
  'done',
  'failed',
  'cancelled',
];

export const QUEUE_GROUP_STATUSES: TaskStatusDto[] = [...TASK_STATUSES];

export const TERMINAL_STATUSES: TaskStatusDto[] = ['done', 'cancelled'];

export type ReasonMode = 'none' | 'recommended' | 'required';

export interface CommandPolicy {
  command: TaskCommandName;
  label: string;
  icon: string;
  capability: keyof SessionDto['capabilities'];
  statuses?: TaskStatusDto[];
  hideOnTerminal?: boolean;
  reason: ReasonMode;
  help: string;
}

const STATUS_LABELS: Record<string, string> = {
  new: 'Новая',
  triage: 'Триаж',
  ready: 'Готова',
  claimed: 'Назначена',
  analyzing: 'Анализ',
  awaiting_human: 'Ждет человека',
  decomposing: 'Декомпозиция',
  implementing: 'В работе',
  validating: 'Проверка',
  review: 'Ревью',
  human_testing: 'Тестируется человеком',
  fixing_review: 'Исправление ревью',
  blocked: 'Заблокирована',
  done: 'Завершена',
  failed: 'Ошибка',
  cancelled: 'Отменена',
  codex_agent_message: 'Сообщение Codex',
  codex_command_started: 'Команда Codex началась',
  codex_command_progress: 'Codex выполняется',
  codex_command_completed: 'Команда Codex завершена',
  codex_turn_completed: 'Ход Codex завершен',
  codex_error: 'Ошибка Codex',
};

export const TASK_COMMAND_POLICIES: CommandPolicy[] = [
  {
    command: 'mark-ready',
    label: 'В готовые',
    icon: 'pi pi-check-circle',
    capability: 'canUpdateTask',
    statuses: ['new', 'triage', 'blocked'],
    reason: 'recommended',
    help: 'Перемещает черновик или заблокированную задачу в очередь готовых.',
  },
  {
    command: 'resume',
    label: 'Возобновить',
    icon: 'pi pi-play',
    capability: 'canResume',
    statuses: ['awaiting_human', 'blocked'],
    reason: 'recommended',
    help: 'Возвращает задачу в готовую очередь после ответа человека.',
  },
  {
    command: 'cancel',
    label: 'Отменить',
    icon: 'pi pi-times',
    capability: 'canCancel',
    hideOnTerminal: true,
    reason: 'required',
    help: 'Отменяет задачу, если backend разрешает такой переход.',
  },
  {
    command: 'hold',
    label: 'Поставить на паузу',
    icon: 'pi pi-pause',
    capability: 'canHold',
    statuses: [
      'ready',
      'claimed',
      'analyzing',
      'awaiting_human',
      'implementing',
      'validating',
      'review',
      'human_testing',
    ],
    reason: 'required',
    help: 'Ставит активную или ожидающую задачу на паузу.',
  },
  {
    command: 'retry',
    label: 'Повторить',
    icon: 'pi pi-refresh',
    capability: 'canRetry',
    statuses: ['failed', 'blocked'],
    reason: 'required',
    help: 'Возвращает ошибочную или заблокированную задачу на повторную попытку.',
  },
  {
    command: 'force-reanalysis',
    label: 'Переанализировать',
    icon: 'pi pi-search',
    capability: 'canForceReanalysis',
    hideOnTerminal: true,
    reason: 'required',
    help: 'Записывает ручной запрос на повторный анализ без гарантии немедленного перезапуска.',
  },
];

export const statusLabel = (status: string): string =>
  STATUS_LABELS[status] ??
  status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

export const statusSeverity = (status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' => {
  if (status === 'done') {
    return 'success';
  }
  if (status === 'failed' || status === 'cancelled') {
    return 'danger';
  }
  if (status === 'codex_error') {
    return 'danger';
  }
  if (status === 'blocked' || status === 'awaiting_human') {
    return 'warn';
  }
  if (status === 'ready' || status === 'review' || status === 'human_testing') {
    return 'info';
  }
  return 'secondary';
};

export const PROJECT_GOAL_STATUS_LABELS: Record<string, string> = {
  proposed: 'Предложено',
  approved: 'Одобрено',
  active: 'Активно',
  completed: 'Завершено',
  rejected: 'Отклонено',
  stale: 'Устарело',
};

export const PROJECT_GOAL_PRIORITY_LABELS: Record<string, string> = {
  low: 'Низкий',
  normal: 'Обычный',
  high: 'Высокий',
  critical: 'Критический',
};

export const PROJECT_GOAL_RISK_LABELS: Record<string, string> = {
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
};

export const PROJECT_STRATEGY_DIMENSION_LABELS: Record<string, string> = {
  product: 'Продукт',
  technical: 'Техника',
  product_technical: 'Продукт и техника',
};

export const PROJECT_STRATEGY_NEXT_STEP_LABELS: Record<string, string> = {
  create_goal: 'Создать цель',
  research: 'Исследовать',
  ask_human: 'Спросить человека',
  defer: 'Отложить',
};

export const PROJECT_STRATEGY_ARCHITECT_VERDICT_LABELS: Record<string, string> = {
  pursue: 'Брать в работу',
  research_first: 'Сначала исследовать',
  defer: 'Отложить',
  reject: 'Отклонить',
};

export const projectGoalStatusLabel = (status: string): string =>
  PROJECT_GOAL_STATUS_LABELS[status] ?? statusLabel(status);

export const projectGoalStatusSeverity = (
  status: string,
): 'success' | 'info' | 'warn' | 'danger' | 'secondary' => {
  if (status === 'completed') {
    return 'success';
  }
  if (status === 'active' || status === 'approved') {
    return 'info';
  }
  if (status === 'proposed') {
    return 'warn';
  }
  if (status === 'rejected' || status === 'stale') {
    return 'danger';
  }
  return 'secondary';
};

export const projectGoalPriorityLabel = (priority: string): string =>
  PROJECT_GOAL_PRIORITY_LABELS[priority] ?? statusLabel(priority);

export const projectGoalPrioritySeverity = (
  priority: string,
): 'success' | 'info' | 'warn' | 'danger' | 'secondary' => {
  if (priority === 'critical') {
    return 'danger';
  }
  if (priority === 'high') {
    return 'warn';
  }
  return 'secondary';
};

export const projectGoalRiskLabel = (riskLevel: string): string =>
  PROJECT_GOAL_RISK_LABELS[riskLevel] ?? statusLabel(riskLevel);

export const projectGoalRiskSeverity = (
  riskLevel: string,
): 'success' | 'info' | 'warn' | 'danger' | 'secondary' => {
  if (riskLevel === 'high') {
    return 'danger';
  }
  if (riskLevel === 'medium') {
    return 'warn';
  }
  return 'success';
};

export const projectStrategyDimensionLabel = (dimension: string): string =>
  PROJECT_STRATEGY_DIMENSION_LABELS[dimension] ?? statusLabel(dimension);

export const projectStrategyNextStepLabel = (nextStep: string): string =>
  PROJECT_STRATEGY_NEXT_STEP_LABELS[nextStep] ?? statusLabel(nextStep);

export const projectStrategyArchitectVerdictLabel = (verdict: string): string =>
  PROJECT_STRATEGY_ARCHITECT_VERDICT_LABELS[verdict] ?? statusLabel(verdict);

export const projectConfidenceLabel = (confidence: number): string =>
  `Уверенность: ${Math.round(confidence)}%`;

export const canUseCapability = (
  session: SessionDto | undefined,
  capability: keyof SessionDto['capabilities'],
): boolean => session?.capabilities[capability] === true;

export const commandVisible = (
  policy: CommandPolicy,
  status: TaskStatusDto,
  session: SessionDto | undefined,
): boolean => {
  if (!canUseCapability(session, policy.capability)) {
    return false;
  }
  if (policy.hideOnTerminal && TERMINAL_STATUSES.includes(status)) {
    return false;
  }
  return !policy.statuses || policy.statuses.includes(status);
};

export const formatDate = (value: string | undefined): string => {
  if (!value) {
    return 'Неизвестно';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

export const truncate = (value: string | undefined, max = 220): string => {
  const text = value?.trim() ?? '';
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}...`;
};

export const splitListInput = (value: string | null | undefined): string[] =>
  (value ?? '')
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
