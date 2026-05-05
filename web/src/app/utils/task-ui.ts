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
  'fixing_review',
  'blocked',
  'done',
  'failed',
  'cancelled',
];

export const QUEUE_GROUP_STATUSES: TaskStatusDto[] = [
  'ready',
  'awaiting_human',
  'review',
  'failed',
  'blocked',
];

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
  fixing_review: 'Исправление ревью',
  blocked: 'Заблокирована',
  done: 'Завершена',
  failed: 'Ошибка',
  cancelled: 'Отменена',
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
    statuses: ['ready', 'claimed', 'analyzing', 'awaiting_human', 'implementing', 'validating', 'review'],
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
  if (status === 'blocked' || status === 'awaiting_human') {
    return 'warn';
  }
  if (status === 'ready' || status === 'review') {
    return 'info';
  }
  return 'secondary';
};

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
