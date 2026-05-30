import type { TelegramBlock, TelegramResponse } from "../../integrations/telegram/renderer.js";
import type {
  ClarificationQuestionRecord,
  MergeRequestRecord,
  TaskEvent,
  TaskRecord,
  TaskStep,
} from "../taskTracker/index.js";

export const summarizeTaskForTelegram = (task: TaskRecord): TelegramResponse => {
  const blocks: TelegramBlock[] = [
    { kind: "title", text: `${task.id}: ${task.title}` },
    { kind: "field", label: "Статус", value: task.status },
  ];

  if (task.repositoryName) {
    blocks.push({ kind: "field", label: "Репозиторий", value: task.repositoryName });
  }

  const latestStep = latestTaskStep(task);
  if (latestStep) {
    blocks.push({
      kind: "field",
      label: "Сейчас",
      value: describeTaskStep(latestStep),
    });
  }

  const latestEvent = latestByCreatedAt(task.events);
  if (latestEvent) {
    blocks.push({
      kind: "paragraph",
      text: `Последнее событие: ${describeTaskEvent(latestEvent)}`,
    });
  }

  const latestMergeRequest = latestByCreatedAt(task.mergeRequests);
  if (latestMergeRequest) {
    blocks.push({
      kind: "link",
      label: describeMergeRequest(latestMergeRequest),
      url: latestMergeRequest.mergeRequest.url,
    });
  }

  const openQuestion = latestByCreatedAt(
    task.clarificationQuestions.filter((question) => question.status === "open"),
  );
  if (openQuestion) {
    blocks.push({
      kind: "field",
      label: "Вопрос",
      value: describeClarificationQuestion(openQuestion),
    });
  }

  blocks.push({
    kind: "field",
    label: "Дальше",
    value: nextExpectedEvent(task),
  });

  return {
    blocks,
    disableWebPagePreview: true,
  };
};

const latestTaskStep = (task: TaskRecord): TaskStep | undefined => {
  const activePlan = latestByUpdatedAt(
    task.plans.filter((plan) => plan.status === "active"),
  );
  if (activePlan) {
    return latestByUpdatedAt(activePlan.steps);
  }

  const latestPlan = latestByUpdatedAt(task.plans);
  return latestPlan ? latestByUpdatedAt(latestPlan.steps) : undefined;
};

const describeTaskStep = (step: TaskStep): string => {
  const summary = step.outputSummary?.trim();
  if (summary) {
    return `${step.kind} ${step.status}: ${summary}`;
  }
  if (step.diagnostic?.trim()) {
    return `${step.kind} ${step.status}: ${step.diagnostic.trim()}`;
  }
  return `${step.kind} ${step.status}`;
};

const describeTaskEvent = (event: TaskEvent): string => {
  const message = event.message?.trim();
  return message || event.kind;
};

const describeMergeRequest = (mergeRequest: MergeRequestRecord): string =>
  `MR !${mergeRequest.mergeRequest.iid}: ${mergeRequest.mergeRequest.title}`;

const describeClarificationQuestion = (question: ClarificationQuestionRecord): string => {
  if (question.question.blockingReason.trim()) {
    return question.question.blockingReason.trim();
  }
  if (question.question.question.trim()) {
    return question.question.question.trim();
  }
  return question.question.summary;
};

const nextExpectedEvent = (task: TaskRecord): string => {
  switch (task.status) {
    case "new":
    case "triage":
      return "уточнение и приоритизация";
    case "ready":
      return "старт работы worker";
    case "claimed":
    case "analyzing":
    case "decomposing":
    case "implementing":
    case "fixing_review":
      return "следующий агентский event или результат шага";
    case "validating":
      return "результат validation";
    case "review":
      return "review или feedback по MR";
    case "human_testing":
      return "результат ручной проверки";
    case "awaiting_human":
      return "ответ на открытый вопрос";
    case "blocked":
      return "разблокирующий ответ или внешнее изменение";
    case "failed":
      return "решение о повторе или разбор причины";
    case "done":
    case "cancelled":
      return "ничего не ожидается";
  }
};

const latestByCreatedAt = <T extends { createdAt: string }>(items: T[]): T | undefined =>
  [...items].sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))[0];

const latestByUpdatedAt = <T extends { updatedAt: string }>(items: T[]): T | undefined =>
  [...items].sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0];

const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};
