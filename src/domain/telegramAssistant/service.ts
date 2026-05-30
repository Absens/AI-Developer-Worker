import type {
  TelegramClient,
  TelegramUpdate,
} from "../../integrations/telegram/index.js";
import {
  renderTelegramResponse,
  type TelegramResponse,
} from "../../integrations/telegram/renderer.js";
import { TELEGRAM_CALLBACK_DATA_MAX_BYTES } from "../../integrations/telegram/types.js";
import type {
  RepositoryProfile,
  TaskTrackerClient,
  TelegramAssistantConfig,
  TelegramAssistantRole,
} from "../../models/types.js";
import { redactSecrets } from "../../observability/redaction.js";
import type { Logger } from "../../utils/logger.js";
import {
  DuplicateExternalRefError,
  type ClarificationQuestionRecord,
  type HumanAnswerInput,
  type TaskRecord,
} from "../taskTracker/index.js";
import {
  canPerformTelegramWrite,
  resolveTelegramActor,
  resolveTelegramRole,
  shouldProcessGroupMessage,
  type TelegramResolvedActor,
} from "./accessControl.js";
import {
  resolveTelegramTaskCandidates,
  type TelegramTaskCandidate,
} from "./entityResolver.js";
import type { TelegramNotificationRouter } from "./notificationRouter.js";
import { routeTelegramIntent } from "./intentRouter.js";
import type { TelegramAssistantStore } from "./store.js";
import {
  buildHeuristicTaskDraft,
  type TelegramTaskDraft,
} from "./taskDraftBuilder.js";
import { summarizeTaskForTelegram } from "./taskSummaries.js";
import type {
  TelegramAssistantActor,
  TelegramConversationSource,
  TelegramInboundMessage,
  TelegramIntent,
  TelegramPendingAction,
  TelegramQueuedMessage,
} from "./types.js";

type TelegramAssistantLogger = Pick<Logger, "info" | "warn" | "error">;

export interface TelegramAssistantServiceOptions {
  store: TelegramAssistantStore;
  config: TelegramAssistantConfig;
  taskTracker?: TaskTrackerClient;
  repositories: RepositoryProfile[];
  telegram: Pick<TelegramClient, "sendMessage" | "answerCallbackQuery">;
  notificationRouter?: Pick<TelegramNotificationRouter, "scanSubscribedTasks">;
  logger?: TelegramAssistantLogger;
  botUsername?: string;
}

interface NormalizedUpdateCandidate {
  message: TelegramInboundMessage;
  callbackQueryId?: string;
}

interface AnswerAiQuestionCandidate {
  task: TaskRecord;
  question: ClarificationQuestionRecord;
}

type AnswerAiQuestionCandidateResolution =
  | { status: "single"; candidate: AnswerAiQuestionCandidate }
  | { status: "none" }
  | { status: "multiple" };

export type ParsedTelegramCallbackData =
  | { kind: "confirm"; actionKind: string; id: string }
  | { kind: "cancel"; id: string }
  | { kind: "select_task"; taskId: string };

const DEFAULT_OFFSET_SCOPE = "default";
const UNAUTHORIZED_MESSAGE = "У меня нет доступа к этому чату/пользователю.";
const WRITE_ROLE_REQUIRED_MESSAGE =
  "Для действий записи нужен allowlist developer/operator/admin пользователя.";
const TASK_TRACKER_UNAVAILABLE_MESSAGE =
  "Не могу проверить статус задачи: task tracker недоступен.";
const TASK_CREATION_UNAVAILABLE_MESSAGE =
  "Не могу создать задачу: task tracker недоступен.";
const TASK_NOT_FOUND_MESSAGE = "Не нашел задачу. Можешь уточнить тему или task id?";
const ACTION_NOT_FOUND_MESSAGE = "Нет ожидающего действия для подтверждения.";
const ACTION_CANCEL_NOT_FOUND_MESSAGE = "Нет ожидающего действия для отмены.";
const ACTION_CANCELLED_MESSAGE = "Действие отменено.";
const CALLBACK_INVALID_MESSAGE =
  "Не удалось обработать кнопку. Попробуй отправить команду текстом.";
const CALLBACK_NO_MESSAGE_MESSAGE = "Не удалось определить чат для действия.";
const CALLBACK_ACTION_ALREADY_HANDLED_MESSAGE =
  "Это действие уже выполнено или истекло.";
const CALLBACK_ACTION_OTHER_USER_MESSAGE =
  "Это действие создано для другого пользователя.";
const CALLBACK_ACTION_OTHER_CHAT_MESSAGE =
  "Это действие создано для другого чата.";
const CALLBACK_CREATING_TASK_MESSAGE = "Создаю задачу...";
const CALLBACK_RECORDING_ANSWER_MESSAGE = "Записываю ответ...";
const TASK_ANSWER_UNAVAILABLE_MESSAGE =
  "Не могу ответить на вопрос: task tracker недоступен.";
const ANSWER_QUESTION_NOT_FOUND_MESSAGE =
  "Не нашел открытый вопрос AI. Уточни задачу или дождись вопроса.";
const ANSWER_QUESTION_AMBIGUOUS_MESSAGE =
  "Нашел несколько открытых вопросов AI. Уточни task id или ответь из карточки задачи.";
const ANSWER_QUESTION_CONFIRMATION_UNAVAILABLE_MESSAGE =
  "Не могу ответить на вопрос: не удалось определить сообщение или пользователя.";
const ANSWER_RECORDED_MESSAGE = "Ответ записан. Задача продолжит работу.";

export class TelegramAssistantService {
  private readonly store: TelegramAssistantStore;
  private readonly config: TelegramAssistantConfig;
  private readonly taskTracker?: TaskTrackerClient;
  private readonly repositories: RepositoryProfile[];
  private readonly telegram: Pick<TelegramClient, "sendMessage" | "answerCallbackQuery">;
  private readonly notificationRouter?: Pick<
    TelegramNotificationRouter,
    "scanSubscribedTasks"
  >;
  private readonly logger?: TelegramAssistantLogger;
  private readonly botUsername?: string;

  public constructor(options: TelegramAssistantServiceOptions) {
    this.store = options.store;
    this.config = options.config;
    this.taskTracker = options.taskTracker;
    this.repositories = options.repositories;
    this.telegram = options.telegram;
    this.notificationRouter = options.notificationRouter;
    this.logger = options.logger;
    this.botUsername = options.botUsername ?? this.config.botUsername;
  }

  public async scanNotifications(): Promise<void> {
    await this.notificationRouter?.scanSubscribedTasks();
  }

  public async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (await this.store.isUpdateProcessed(update.update_id)) {
      await this.saveOffsetAfter(update.update_id);
      return;
    }

    if (update.callback_query) {
      try {
        await this.handleCallbackUpdate(update);
        await this.markProcessedAndAdvance(update.update_id);
      } catch (error) {
        this.logger?.warn("Telegram assistant failed to handle update.", redactSecrets({
          updateId: update.update_id,
          error: errorToMessage(error),
        }));
        throw error;
      }
      return;
    }

    const message = normalizeTelegramUpdate(update, this.config);
    if (!message) {
      await this.markProcessedAndAdvance(update.update_id);
      return;
    }

    try {
      await this.store.withConversationLock(
        message.conversationKey,
        async () => {
          if (!this.config.enabled) {
            return;
          }

          if (
            message.source === "group" &&
            !shouldProcessGroupMessage({
              text: message.text,
              groupMode: this.config.groupMode,
              botUsername: this.botUsername,
              isReplyToBot: message.isReplyToBot,
              replyToBotUsername: message.replyToBotUsername,
            })
          ) {
            return;
          }

          const actor = resolveTelegramActor(this.config, message);
          if (!actor.allowed) {
            await this.telegram.sendMessage({
              chatId: String(message.chatId),
              text: UNAUTHORIZED_MESSAGE,
              ...(message.businessConnectionId
                ? { businessConnectionId: message.businessConnectionId }
                : {}),
            });
            return;
          }

          await this.recordMessageRef(message);

          const activeTurn = await this.store.getActiveAssistantTurn(
            message.conversationKey,
          );
          if (activeTurn) {
            await this.store.enqueueMessage(this.buildQueuedMessage(message));
            return;
          }

          const intent = routeTelegramIntent(message.text, {
            projectQaEnabled: this.config.projectQaEnabled,
          });
          if (
            intent.safetyLevel === "confirm_write" &&
            !canPerformTelegramWrite(actor)
          ) {
            await this.telegram.sendMessage({
              chatId: String(message.chatId),
              text: WRITE_ROLE_REQUIRED_MESSAGE,
              ...(message.messageId
                ? { replyToMessageId: message.messageId }
                : {}),
              ...(message.businessConnectionId
                ? { businessConnectionId: message.businessConnectionId }
                : {}),
            });
            return;
          }

          if (intent.name === "task_status") {
            await this.handleTaskStatus(message, intent.rawText ?? message.text ?? "");
            return;
          }

          if (intent.name === "create_task_draft") {
            await this.handleCreateTaskDraft(
              message,
              intent,
              intent.rawText ?? message.text ?? "",
            );
            return;
          }

          if (intent.name === "answer_ai_question") {
            await this.handleAnswerAiQuestion(
              message,
              intent,
              intent.rawText ?? message.text ?? "",
            );
            return;
          }

          if (intent.name === "approve_action") {
            await this.handleApproveAction(message);
            return;
          }

          if (intent.name === "reject_action") {
            await this.handleRejectAction(message);
            return;
          }

          await this.sendPlainMessage(message, `Intent: ${intent.name}`);
        },
      );
      await this.markProcessedAndAdvance(update.update_id);
    } catch (error) {
      this.logger?.warn("Telegram assistant failed to handle update.", redactSecrets({
        updateId: update.update_id,
        error: errorToMessage(error),
      }));
      throw error;
    }
  }

  private async handleCallbackUpdate(update: TelegramUpdate): Promise<void> {
    const callback = update.callback_query;
    if (!callback) {
      return;
    }

    if (isCallbackDataTooLong(callback.data)) {
      await this.answerCallback(callback.id, CALLBACK_INVALID_MESSAGE);
      return;
    }

    const parsed = parseCallbackData(callback.data);
    if (!parsed) {
      await this.answerCallback(callback.id, CALLBACK_INVALID_MESSAGE);
      return;
    }

    const candidate = normalizeTelegramCallbackUpdate(update, this.config);
    if (!candidate) {
      await this.answerCallback(callback.id, CALLBACK_NO_MESSAGE_MESSAGE);
      return;
    }

    await this.store.withConversationLock(
      candidate.message.conversationKey,
      async () => {
        if (!this.config.enabled) {
          await this.answerCallback(callback.id, "Ассистент выключен.");
          return;
        }

        const actor = resolveTelegramActor(this.config, candidate.message);
        if (!actor.allowed) {
          await this.answerCallback(callback.id, UNAUTHORIZED_MESSAGE);
          return;
        }

        if (parsed.kind === "select_task") {
          await this.handleSelectTaskCallback(
            callback.id,
            candidate.message,
            parsed.taskId,
          );
          return;
        }

        if (parsed.kind === "cancel") {
          await this.handleCancelCallback(callback.id, candidate.message, parsed.id);
          return;
        }

        await this.handleConfirmCallback(
          callback.id,
          candidate.message,
          actor,
          parsed,
        );
      },
    );
  }

  private async handleConfirmCallback(
    callbackQueryId: string,
    message: TelegramInboundMessage,
    actor: TelegramResolvedActor,
    callback: Extract<ParsedTelegramCallbackData, { kind: "confirm" }>,
  ): Promise<void> {
    if (!isSupportedConfirmActionKind(callback.actionKind)) {
      await this.answerCallback(callbackQueryId, CALLBACK_INVALID_MESSAGE);
      return;
    }

    if (!canPerformTelegramWrite(actor)) {
      await this.answerCallback(callbackQueryId, WRITE_ROLE_REQUIRED_MESSAGE);
      return;
    }

    if (!this.taskTracker) {
      await this.answerCallback(
        callbackQueryId,
        callback.actionKind === "create_task"
          ? TASK_CREATION_UNAVAILABLE_MESSAGE
          : TASK_ANSWER_UNAVAILABLE_MESSAGE,
      );
      return;
    }

    const now = new Date().toISOString();
    const action = await this.store.getPendingAction(callback.id);
    const validationMessage = validateCallbackConfirmAction(action, message, now);
    if (validationMessage) {
      await this.answerCallback(callbackQueryId, validationMessage);
      return;
    }

    if (!action || !isConfirmableActionForCallback(action, callback.actionKind)) {
      await this.answerCallback(callbackQueryId, CALLBACK_INVALID_MESSAGE);
      return;
    }

    const executableAction = action.status === "executing"
      ? action
      : await this.consumePendingActionForMessage(action.id, message, now);
    if (!executableAction) {
      await this.answerCallback(
        callbackQueryId,
        CALLBACK_ACTION_ALREADY_HANDLED_MESSAGE,
      );
      return;
    }

    await this.answerCallback(
      callbackQueryId,
      action.intent.name === "answer_ai_question"
        ? CALLBACK_RECORDING_ANSWER_MESSAGE
        : CALLBACK_CREATING_TASK_MESSAGE,
    );
    await this.completeConfirmedAction(message, executableAction);
  }

  private async handleCancelCallback(
    callbackQueryId: string,
    message: TelegramInboundMessage,
    actionId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const action = await this.store.getPendingAction(actionId);
    const validationMessage = validateCallbackPendingAction(action, message, now);
    if (validationMessage) {
      await this.answerCallback(callbackQueryId, validationMessage);
      return;
    }

    if (!action || !isConfirmablePendingAction(action)) {
      await this.answerCallback(callbackQueryId, CALLBACK_INVALID_MESSAGE);
      return;
    }

    const cancelled = await this.cancelPendingAction(action.id, message, now);
    await this.answerCallback(
      callbackQueryId,
      cancelled ? ACTION_CANCELLED_MESSAGE : CALLBACK_ACTION_ALREADY_HANDLED_MESSAGE,
    );
  }

  private async handleSelectTaskCallback(
    callbackQueryId: string,
    message: TelegramInboundMessage,
    taskId: string,
  ): Promise<void> {
    await this.answerCallback(callbackQueryId);
    if (!this.taskTracker) {
      await this.sendPlainMessage(message, TASK_TRACKER_UNAVAILABLE_MESSAGE);
      return;
    }

    const task = await this.taskTracker.getTask(taskId);
    await this.sendTelegramResponse(message, summarizeTaskForTelegram(task));
  }

  private async handleCreateTaskDraft(
    message: TelegramInboundMessage,
    intent: TelegramIntent,
    text: string,
  ): Promise<void> {
    if (!this.taskTracker) {
      await this.sendPlainMessage(message, TASK_CREATION_UNAVAILABLE_MESSAGE);
      return;
    }
    if (message.messageId === undefined || message.userId === undefined) {
      await this.sendPlainMessage(
        message,
        "Не могу создать задачу: не удалось определить сообщение или пользователя.",
      );
      return;
    }

    const draft = buildHeuristicTaskDraft(
      text,
      this.repositories,
      this.config.defaultRepository,
    );
    const actionId = buildPendingActionId(message.updateId, message.messageId);
    const externalKey = buildTelegramExternalKey(message.chatId, message.messageId);
    const now = new Date().toISOString();
    const pendingAction: TelegramPendingAction = {
      id: actionId,
      conversationKey: message.conversationKey,
      chatId: message.chatId,
      userId: message.userId,
      intent,
      payload: {
        draft,
        chatId: message.chatId,
        messageId: message.messageId,
        userId: message.userId,
        externalKey,
      },
      status: "pending",
      createdAt: now,
      updatedAt: now,
      expiresAt: addDays(now, this.config.conversationRetentionDays),
    };

    await this.store.upsertPendingAction(pendingAction);
    await this.sendTelegramResponse(
      message,
      buildTaskDraftResponse(draft, pendingAction.id),
    );
  }

  private async handleAnswerAiQuestion(
    message: TelegramInboundMessage,
    intent: TelegramIntent,
    text: string,
  ): Promise<void> {
    if (!this.taskTracker) {
      await this.sendPlainMessage(message, TASK_ANSWER_UNAVAILABLE_MESSAGE);
      return;
    }
    if (message.messageId === undefined || message.userId === undefined) {
      await this.sendPlainMessage(
        message,
        ANSWER_QUESTION_CONFIRMATION_UNAVAILABLE_MESSAGE,
      );
      return;
    }

    const candidateResolution = await this.resolveAnswerAiQuestionCandidate();
    if (candidateResolution.status === "none") {
      await this.sendPlainMessage(message, ANSWER_QUESTION_NOT_FOUND_MESSAGE);
      return;
    }
    if (candidateResolution.status === "multiple") {
      await this.sendPlainMessage(message, ANSWER_QUESTION_AMBIGUOUS_MESSAGE);
      return;
    }

    const body = text.trim() || message.text?.trim() || "";
    const command = { type: "resume" as const, rawText: body };
    const actionId = buildPendingActionId(message.updateId, message.messageId);
    const externalKey = buildTelegramAnswerExternalKey(
      message.chatId,
      message.messageId,
      candidateResolution.candidate.question.id,
    );
    const now = new Date().toISOString();
    const pendingAction: TelegramPendingAction = {
      id: actionId,
      conversationKey: message.conversationKey,
      chatId: message.chatId,
      userId: message.userId,
      intent,
      payload: {
        taskId: candidateResolution.candidate.task.id,
        questionId: candidateResolution.candidate.question.id,
        body,
        command,
        chatId: message.chatId,
        messageId: message.messageId,
        userId: message.userId,
        externalKey,
      },
      status: "pending",
      createdAt: now,
      updatedAt: now,
      expiresAt: addDays(now, this.config.conversationRetentionDays),
    };

    await this.store.upsertPendingAction(pendingAction);
    await this.sendTelegramResponse(
      message,
      buildAnswerAiQuestionResponse(
        candidateResolution.candidate,
        body,
        pendingAction.id,
      ),
    );
  }

  private async handleApproveAction(message: TelegramInboundMessage): Promise<void> {
    if (!this.taskTracker) {
      await this.sendPlainMessage(message, TASK_CREATION_UNAVAILABLE_MESSAGE);
      return;
    }
    if (message.userId === undefined) {
      await this.sendPlainMessage(message, ACTION_NOT_FOUND_MESSAGE);
      return;
    }

    const now = new Date().toISOString();
    const action = await this.findLatestConfirmableAction(
      message,
      ["pending", "executing"],
      now,
    );
    if (!action) {
      await this.sendPlainMessage(message, ACTION_NOT_FOUND_MESSAGE);
      return;
    }

    const executableAction = action.status === "executing"
      ? action
      : await this.consumePendingActionForMessage(action.id, message, now);
    if (!executableAction) {
      await this.sendPlainMessage(message, ACTION_NOT_FOUND_MESSAGE);
      return;
    }

    await this.completeConfirmedAction(message, executableAction);
  }

  private async handleRejectAction(message: TelegramInboundMessage): Promise<void> {
    if (message.userId === undefined) {
      await this.sendPlainMessage(message, ACTION_CANCEL_NOT_FOUND_MESSAGE);
      return;
    }

    const now = new Date().toISOString();
    const action = await this.findLatestConfirmableAction(message, ["pending"], now);
    if (!action) {
      await this.sendPlainMessage(message, ACTION_CANCEL_NOT_FOUND_MESSAGE);
      return;
    }

    const cancelled = await this.cancelPendingAction(action.id, message, now);
    if (!cancelled) {
      await this.sendPlainMessage(message, ACTION_CANCEL_NOT_FOUND_MESSAGE);
      return;
    }

    await this.sendPlainMessage(message, ACTION_CANCELLED_MESSAGE);
  }

  private async consumePendingActionForMessage(
    actionId: string,
    message: TelegramInboundMessage,
    now: string,
  ): Promise<TelegramPendingAction | undefined> {
    if (message.userId === undefined) {
      return undefined;
    }

    return this.store.consumePendingAction({
      actionId,
      chatId: message.chatId,
      userId: message.userId,
      terminalStatus: "executing",
      now,
    });
  }

  private async cancelPendingAction(
    actionId: string,
    message: TelegramInboundMessage,
    now: string,
  ): Promise<TelegramPendingAction | undefined> {
    if (message.userId === undefined) {
      return undefined;
    }

    const cancelled = await this.store.consumePendingAction({
      actionId,
      chatId: message.chatId,
      userId: message.userId,
      terminalStatus: "cancelled",
      now,
    });
    if (!cancelled) {
      return undefined;
    }

    await this.store.cancelQueuedMessages(message.conversationKey, {
      cancelledAt: now,
    });
    return cancelled;
  }

  private async completeConfirmedAction(
    message: TelegramInboundMessage,
    executableAction: TelegramPendingAction,
  ): Promise<void> {
    if (executableAction.intent.name === "create_task_draft") {
      await this.completeCreateTaskAction(message, executableAction);
      return;
    }
    if (executableAction.intent.name === "answer_ai_question") {
      await this.completeAnswerAiQuestionAction(message, executableAction);
      return;
    }

    throw new Error(`Unsupported telegram pending action: ${executableAction.intent.name}`);
  }

  private async completeCreateTaskAction(
    message: TelegramInboundMessage,
    executableAction: TelegramPendingAction,
  ): Promise<void> {
    const task = await this.findOrCreateTaskFromPendingAction(executableAction);
    await this.store.completePendingAction(executableAction.id, {
      status: "completed",
    });
    await this.subscribeConversationToTask(message, task);
    await this.sendPlainMessage(message, `Задача создана: ${task.id}`);
  }

  private async completeAnswerAiQuestionAction(
    message: TelegramInboundMessage,
    executableAction: TelegramPendingAction,
  ): Promise<void> {
    if (!this.taskTracker) {
      throw new Error("Task tracker is required to answer AI questions from telegram.");
    }

    const payload = parseAnswerAiQuestionPayload(executableAction.payload);
    const answer: HumanAnswerInput = {
      questionId: payload.questionId,
      author: buildTelegramHumanAnswerAuthor(message, payload.userId),
      body: payload.body,
      command: payload.command,
    };
    if (!(await this.hasRecordedTelegramAnswer(payload, answer))) {
      await this.taskTracker.recordHumanAnswer(payload.taskId, answer);
    }
    await this.store.completePendingAction(executableAction.id, {
      status: "completed",
    });
    await this.sendPlainMessage(message, ANSWER_RECORDED_MESSAGE);
  }

  private async hasRecordedTelegramAnswer(
    payload: AnswerAiQuestionPayload,
    answer: HumanAnswerInput,
  ): Promise<boolean> {
    if (!this.taskTracker) {
      return false;
    }

    const task = await this.taskTracker.getTask(payload.taskId);
    return task.humanAnswers.some(
      (candidate) =>
        candidate.questionId === answer.questionId &&
        candidate.body === answer.body &&
        candidate.author.id === answer.author.id &&
        candidate.command?.type === answer.command?.type &&
        candidate.command?.rawText === answer.command?.rawText,
    );
  }

  private async resolveAnswerAiQuestionCandidate(): Promise<
    AnswerAiQuestionCandidateResolution
  > {
    if (!this.taskTracker) {
      return { status: "none" };
    }

    const tasks = await this.taskTracker.listTasks({
      statuses: ["awaiting_human"],
      limit: 500,
    });
    const candidates = tasks
      .map((task) => {
        const question = latestOpenClarificationQuestion(task);
        return question ? { task, question } : undefined;
      })
      .filter((candidate): candidate is AnswerAiQuestionCandidate => (
        candidate !== undefined
      ));

    if (candidates.length === 0) {
      return { status: "none" };
    }
    if (candidates.length > 1) {
      return { status: "multiple" };
    }

    const candidate = candidates[0];
    if (!candidate) {
      return { status: "none" };
    }

    return { status: "single", candidate };
  }

  private async findLatestConfirmableAction(
    message: TelegramInboundMessage,
    statuses: TelegramPendingAction["status"][],
    now: string,
  ): Promise<TelegramPendingAction | undefined> {
    const actions = await this.store.listPendingActions({
      conversationKey: message.conversationKey,
      status: statuses,
    });
    return actions
      .filter(
        (action) =>
          isConfirmablePendingAction(action) &&
          action.chatId === message.chatId &&
          action.userId === message.userId &&
          isPendingActionUnexpired(action, now),
      )
      .sort(comparePendingActionsNewestFirst)[0];
  }

  private async findOrCreateTaskFromPendingAction(
    action: TelegramPendingAction,
  ): Promise<TaskRecord> {
    if (!this.taskTracker) {
      throw new Error("Task tracker is required to create telegram task drafts.");
    }

    const payload = parseTaskDraftPayload(action.payload);
    const existing = await this.taskTracker.findTaskByExternalRef(
      "telegram",
      payload.externalKey,
    );
    if (existing) {
      return existing;
    }

    try {
      return await this.taskTracker.createTask({
        title: payload.draft.title,
        description: payload.draft.description,
        source: {
          kind: "system",
          provider: "telegram",
          externalKey: payload.externalKey,
        },
        createdBy: {
          owner: "external_source",
          id: "telegram",
          displayName: "Telegram Assistant",
        },
        repositoryName: payload.draft.repositoryName,
        tags: payload.draft.tags,
        acceptanceCriteria: payload.draft.acceptanceCriteria,
        externalRefs: [
          { provider: "telegram", externalKey: payload.externalKey },
        ],
        externalSnapshot: {
          chatId: payload.chatId,
          messageId: payload.messageId,
          userId: payload.userId,
        },
      });
    } catch (error) {
      if (error instanceof DuplicateExternalRefError) {
        const existingAfterRace = await this.taskTracker.findTaskByExternalRef(
          "telegram",
          payload.externalKey,
        );
        if (existingAfterRace) {
          return existingAfterRace;
        }
      }
      throw error;
    }
  }

  private async subscribeConversationToTask(
    message: TelegramInboundMessage,
    task: TaskRecord,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.store.upsertTaskSubscription({
      id: buildTaskSubscriptionId(message.conversationKey, task.id),
      taskId: task.id,
      conversationKey: message.conversationKey,
      chatId: message.chatId,
      ...(message.userId !== undefined ? { userId: message.userId } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }

  private async handleTaskStatus(
    message: TelegramInboundMessage,
    query: string,
  ): Promise<void> {
    if (!this.taskTracker) {
      await this.sendPlainMessage(message, TASK_TRACKER_UNAVAILABLE_MESSAGE);
      return;
    }

    const tasks = await this.taskTracker.listTasks({ limit: 500 });
    const candidates = resolveTelegramTaskCandidates(query, tasks);
    const topCandidate = candidates[0];
    if (!topCandidate) {
      await this.sendPlainMessage(message, TASK_NOT_FOUND_MESSAGE);
      return;
    }

    const secondCandidate = candidates[1];
    const hasStrongUniqueCandidate =
      topCandidate.score >= 20 &&
      (secondCandidate === undefined || secondCandidate.score < topCandidate.score);
    if (hasStrongUniqueCandidate) {
      const task = await this.taskTracker.getTask(topCandidate.task.id);
      await this.sendTelegramResponse(message, summarizeTaskForTelegram(task));
      return;
    }

    await this.sendTelegramResponse(
      message,
      buildTaskChoiceResponse(candidates.slice(0, 5)),
    );
  }

  private async sendPlainMessage(
    message: TelegramInboundMessage,
    text: string,
  ): Promise<void> {
    await this.telegram.sendMessage({
      chatId: String(message.chatId),
      text,
      ...(message.messageId
        ? { replyToMessageId: message.messageId }
        : {}),
      ...(message.businessConnectionId
        ? { businessConnectionId: message.businessConnectionId }
        : {}),
    });
  }

  private async answerCallback(
    callbackQueryId: string,
    text?: string,
  ): Promise<void> {
    await this.telegram.answerCallbackQuery({
      callbackQueryId,
      ...(text !== undefined ? { text } : {}),
    });
  }

  private async sendTelegramResponse(
    message: TelegramInboundMessage,
    response: TelegramResponse,
  ): Promise<void> {
    const rendered = renderTelegramResponse(response);

    for (let index = 0; index < rendered.messages.length; index += 1) {
      const text = rendered.messages[index];
      if (text === undefined) {
        continue;
      }

      await this.telegram.sendMessage({
        chatId: String(message.chatId),
        text,
        parseMode: rendered.parseMode,
        ...(rendered.disableWebPagePreview !== undefined
          ? { disableWebPagePreview: rendered.disableWebPagePreview }
          : {}),
        ...(index === 0 && message.messageId
          ? { replyToMessageId: message.messageId }
          : {}),
        ...(index === 0 && rendered.replyMarkup
          ? { replyMarkup: rendered.replyMarkup }
          : {}),
        ...(message.businessConnectionId
          ? { businessConnectionId: message.businessConnectionId }
          : {}),
      });
    }
  }

  private buildQueuedMessage(message: TelegramInboundMessage): TelegramQueuedMessage {
    const createdAt = new Date().toISOString();
    return {
      id: `queued:${message.updateId}`,
      conversationKey: message.conversationKey,
      chatId: message.chatId,
      ...(message.userId !== undefined ? { userId: message.userId } : {}),
      message,
      status: "queued",
      createdAt,
      expiresAt: addDays(createdAt, this.config.conversationRetentionDays),
    };
  }

  private async recordMessageRef(message: TelegramInboundMessage): Promise<void> {
    if (message.messageId === undefined || message.redactedText === undefined) {
      return;
    }

    await this.store.recordMessageRef({
      id: `message-ref:${message.updateId}:${message.messageId}`,
      conversationKey: message.conversationKey,
      chatId: message.chatId,
      messageId: message.messageId,
      source: "user",
      redactedText: message.redactedText,
      createdAt: message.receivedAt,
      expiresAt: addDays(message.receivedAt, this.config.conversationRetentionDays),
    });
  }

  private async markProcessedAndAdvance(updateId: number): Promise<void> {
    await this.store.markUpdateProcessed(updateId);
    await this.saveOffsetAfter(updateId);
  }

  private async saveOffsetAfter(updateId: number): Promise<void> {
    const nextOffset = updateId + 1;
    const currentOffset = await this.store.getOffset(DEFAULT_OFFSET_SCOPE);
    if (currentOffset === undefined || currentOffset < nextOffset) {
      await this.store.saveOffset(DEFAULT_OFFSET_SCOPE, nextOffset);
    }
  }
}

const validateCallbackPendingAction = (
  action: TelegramPendingAction | undefined,
  message: TelegramInboundMessage,
  now: string,
): string | undefined => {
  if (!action) {
    return CALLBACK_ACTION_ALREADY_HANDLED_MESSAGE;
  }
  if (action.chatId !== message.chatId) {
    return CALLBACK_ACTION_OTHER_CHAT_MESSAGE;
  }
  if (message.userId === undefined || action.userId !== message.userId) {
    return CALLBACK_ACTION_OTHER_USER_MESSAGE;
  }
  if (action.status !== "pending" || !isPendingActionUnexpired(action, now)) {
    return CALLBACK_ACTION_ALREADY_HANDLED_MESSAGE;
  }
  return undefined;
};

const validateCallbackConfirmAction = (
  action: TelegramPendingAction | undefined,
  message: TelegramInboundMessage,
  now: string,
): string | undefined => {
  if (!action) {
    return CALLBACK_ACTION_ALREADY_HANDLED_MESSAGE;
  }
  if (action.chatId !== message.chatId) {
    return CALLBACK_ACTION_OTHER_CHAT_MESSAGE;
  }
  if (message.userId === undefined || action.userId !== message.userId) {
    return CALLBACK_ACTION_OTHER_USER_MESSAGE;
  }
  if (!isPendingActionUnexpired(action, now)) {
    return CALLBACK_ACTION_ALREADY_HANDLED_MESSAGE;
  }
  if (action.status !== "pending" && action.status !== "executing") {
    return CALLBACK_ACTION_ALREADY_HANDLED_MESSAGE;
  }
  return undefined;
};

const buildTaskChoiceResponse = (
  candidates: TelegramTaskCandidate[],
): TelegramResponse => ({
  blocks: [
    { kind: "title", text: "Нашел несколько задач" },
    { kind: "paragraph", text: "Выбери нужную задачу:" },
    ...candidates.map((candidate) => ({
      kind: "field" as const,
      label: candidate.task.id,
      value: `${candidate.task.title} (${candidate.task.status})`,
    })),
  ],
  inlineButtonRows: candidates.map((candidate) => [
    {
      text: formatTaskButtonText(candidate.task.id, candidate.task.title),
      callbackData: `select_task:${candidate.task.id}`,
    },
  ]),
  disableWebPagePreview: true,
});

const buildTaskDraftResponse = (
  draft: TelegramTaskDraft,
  actionId: string,
): TelegramResponse => ({
  blocks: [
    { kind: "title", text: "Создать задачу?" },
    { kind: "field", label: "Название", value: draft.title },
    ...(draft.repositoryName
      ? [{ kind: "field" as const, label: "Репозиторий", value: draft.repositoryName }]
      : []),
    { kind: "paragraph", text: draft.description },
    {
      kind: "field",
      label: "Критерии",
      value: draft.acceptanceCriteria.join("\n"),
    },
  ],
  inlineButtonRows: [
    [
      { text: "Создать", callbackData: `c:${actionId}` },
      { text: "Отмена", callbackData: `cancel:${actionId}` },
    ],
  ],
  disableWebPagePreview: true,
});

const buildAnswerAiQuestionResponse = (
  candidate: AnswerAiQuestionCandidate,
  body: string,
  actionId: string,
): TelegramResponse => ({
  blocks: [
    { kind: "title", text: "Ответить AI?" },
    { kind: "field", label: "Задача", value: candidate.task.id },
    {
      kind: "field",
      label: "Вопрос",
      value: describeClarificationQuestion(candidate.question),
    },
    { kind: "field", label: "Ответ", value: body },
  ],
  inlineButtonRows: [
    [
      { text: "Ответить", callbackData: `confirm:answer_question:${actionId}` },
      { text: "Отмена", callbackData: `cancel:${actionId}` },
    ],
  ],
  disableWebPagePreview: true,
});

const formatTaskButtonText = (taskId: string, title: string): string => {
  const text = `${taskId}: ${title}`;
  if (text.length <= 64) {
    return text;
  }

  return `${text.slice(0, 61)}...`;
};

interface TaskDraftPayload {
  draft: TelegramTaskDraft;
  chatId: number;
  messageId: number;
  userId: number;
  externalKey: string;
}

interface TelegramResumeCommand {
  type: "resume";
  rawText: string;
}

interface AnswerAiQuestionPayload {
  taskId: string;
  questionId: string;
  body: string;
  command: TelegramResumeCommand;
  chatId: number;
  messageId: number;
  userId: number;
  externalKey: string;
}

const parseTaskDraftPayload = (
  payload: Record<string, unknown>,
): TaskDraftPayload => {
  const draft = payload.draft;
  if (
    !isTelegramTaskDraft(draft) ||
    typeof payload.chatId !== "number" ||
    typeof payload.messageId !== "number" ||
    typeof payload.userId !== "number" ||
    typeof payload.externalKey !== "string"
  ) {
    throw new Error("Invalid telegram task draft payload.");
  }

  return {
    draft,
    chatId: payload.chatId,
    messageId: payload.messageId,
    userId: payload.userId,
    externalKey: payload.externalKey,
  };
};

const parseAnswerAiQuestionPayload = (
  payload: Record<string, unknown>,
): AnswerAiQuestionPayload => {
  const command = payload.command;
  if (
    typeof payload.taskId !== "string" ||
    typeof payload.questionId !== "string" ||
    typeof payload.body !== "string" ||
    !isTelegramResumeCommand(command) ||
    typeof payload.chatId !== "number" ||
    typeof payload.messageId !== "number" ||
    typeof payload.userId !== "number" ||
    typeof payload.externalKey !== "string"
  ) {
    throw new Error("Invalid telegram AI answer payload.");
  }

  return {
    taskId: payload.taskId,
    questionId: payload.questionId,
    body: payload.body,
    command,
    chatId: payload.chatId,
    messageId: payload.messageId,
    userId: payload.userId,
    externalKey: payload.externalKey,
  };
};

const isTelegramTaskDraft = (value: unknown): value is TelegramTaskDraft => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const draft = value as Partial<TelegramTaskDraft>;
  return (
    typeof draft.title === "string" &&
    typeof draft.description === "string" &&
    Array.isArray(draft.acceptanceCriteria) &&
    draft.acceptanceCriteria.every((criterion) => typeof criterion === "string") &&
    (draft.repositoryName === undefined || typeof draft.repositoryName === "string") &&
    Array.isArray(draft.tags) &&
    draft.tags.every((tag) => typeof tag === "string")
  );
};

const isTelegramResumeCommand = (value: unknown): value is TelegramResumeCommand => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const command = value as Partial<TelegramResumeCommand>;
  return command.type === "resume" && typeof command.rawText === "string";
};

const isConfirmablePendingAction = (action: TelegramPendingAction): boolean =>
  action.intent.name === "create_task_draft" ||
  action.intent.name === "answer_ai_question";

const isSupportedConfirmActionKind = (actionKind: string): boolean =>
  actionKind === "create_task" || actionKind === "answer_question";

const isConfirmableActionForCallback = (
  action: TelegramPendingAction,
  actionKind: string,
): boolean =>
  (actionKind === "create_task" && action.intent.name === "create_task_draft") ||
  (
    actionKind === "answer_question" &&
    action.intent.name === "answer_ai_question"
  );

const latestOpenClarificationQuestion = (
  task: TaskRecord,
): ClarificationQuestionRecord | undefined =>
  task.clarificationQuestions
    .filter((question) => question.status === "open")
    .sort(compareClarificationQuestionsNewestFirst)[0];

const compareClarificationQuestionsNewestFirst = (
  left: ClarificationQuestionRecord,
  right: ClarificationQuestionRecord,
): number =>
  right.createdAt.localeCompare(left.createdAt) ||
  right.id.localeCompare(left.id);

const describeClarificationQuestion = (
  question: ClarificationQuestionRecord,
): string => {
  const directQuestion = question.question.question.trim();
  if (directQuestion) {
    return directQuestion;
  }

  const blockingReason = question.question.blockingReason.trim();
  if (blockingReason) {
    return blockingReason;
  }

  return question.question.summary;
};

const comparePendingActionsNewestFirst = (
  left: TelegramPendingAction,
  right: TelegramPendingAction,
): number =>
  right.updatedAt.localeCompare(left.updatedAt) ||
  right.createdAt.localeCompare(left.createdAt) ||
  right.id.localeCompare(left.id);

const isPendingActionUnexpired = (
  action: TelegramPendingAction,
  now: string,
): boolean => Date.parse(action.expiresAt) > Date.parse(now);

const buildPendingActionId = (updateId: number, messageId: number): string =>
  `tgpa_${updateId.toString(36)}_${messageId.toString(36)}`;

const buildTelegramExternalKey = (chatId: number, messageId: number): string =>
  `telegram:${chatId}:${messageId}`;

const buildTelegramAnswerExternalKey = (
  chatId: number,
  messageId: number,
  questionId: string,
): string => `telegram_answer:${chatId}:${messageId}:${questionId}`;

const buildTaskSubscriptionId = (
  conversationKey: string,
  taskId: string,
): string => `task-subscription:${conversationKey}:${taskId}`;

const buildTelegramHumanAnswerAuthor = (
  message: TelegramInboundMessage,
  userId: number,
): HumanAnswerInput["author"] => {
  const displayName = message.actor?.displayName?.trim();
  return {
    owner: "human",
    id: `telegram:${userId}`,
    ...(displayName ? { displayName } : {}),
  };
};

export const normalizeTelegramUpdate = (
  update: TelegramUpdate,
  config: TelegramAssistantConfig,
): TelegramInboundMessage | undefined => {
  const candidate = normalizeTelegramUpdateCandidate(update, config);
  return candidate?.message;
};

export const parseCallbackData = (
  value: string | undefined,
): ParsedTelegramCallbackData | undefined => {
  if (!value || isCallbackDataTooLong(value)) {
    return undefined;
  }

  const parts = value.split(":");
  if (parts[0] === "c" && parts.length === 2 && parts[1]) {
    return { kind: "confirm", actionKind: "create_task", id: parts[1] };
  }
  if (
    parts[0] === "confirm" &&
    parts.length === 3 &&
    parts[1] &&
    parts[2]
  ) {
    return { kind: "confirm", actionKind: parts[1], id: parts[2] };
  }
  if (parts[0] === "cancel" && parts.length === 2 && parts[1]) {
    return { kind: "cancel", id: parts[1] };
  }
  if (parts[0] === "select_task" && parts.length === 2 && parts[1]) {
    return { kind: "select_task", taskId: parts[1] };
  }
  return undefined;
};

const isCallbackDataTooLong = (value: string | undefined): boolean =>
  value !== undefined &&
  Buffer.byteLength(value, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES;

const normalizeTelegramCallbackUpdate = (
  update: TelegramUpdate,
  config: TelegramAssistantConfig,
): NormalizedUpdateCandidate | undefined => {
  const callback = update.callback_query;
  if (!callback?.message) {
    return undefined;
  }

  return normalizeMessage({
    update,
    config,
    message: callback.message,
    user: callback.from,
    text: callback.message.text,
    idSuffix: `callback:${callback.id}`,
  });
};

const normalizeTelegramUpdateCandidate = (
  update: TelegramUpdate,
  config: TelegramAssistantConfig,
): NormalizedUpdateCandidate | undefined => {
  if (update.callback_query) {
    return normalizeTelegramCallbackUpdate(update, config);
  }

  if (update.business_message) {
    return normalizeMessage({
      update,
      config,
      message: update.business_message,
      user: update.business_message.from,
      text: update.business_message.text,
      idSuffix: `business_message:${update.business_message.message_id}`,
      forceSource: "business",
    });
  }

  if (update.edited_business_message) {
    return normalizeMessage({
      update,
      config,
      message: update.edited_business_message,
      user: update.edited_business_message.from,
      text: update.edited_business_message.text,
      idSuffix: `edited_business_message:${update.edited_business_message.message_id}`,
      forceSource: "business",
    });
  }

  if (update.message) {
    return normalizeMessage({
      update,
      config,
      message: update.message,
      user: update.message.from,
      text: update.message.text,
      idSuffix: `message:${update.message.message_id}`,
    });
  }

  return undefined;
};

interface NormalizeMessageInput {
  update: TelegramUpdate;
  config: TelegramAssistantConfig;
  message: NonNullable<TelegramUpdate["message"]>;
  user?: NonNullable<TelegramUpdate["message"]>["from"];
  text?: string;
  idSuffix: string;
  forceSource?: TelegramConversationSource;
}

const normalizeMessage = (
  input: NormalizeMessageInput,
): NormalizedUpdateCandidate | undefined => {
  const source = input.forceSource ?? sourceForChat(input.message.chat.type);
  if (!source) {
    return undefined;
  }

  const businessConnectionId = input.message.business_connection_id;
  if (source === "business" && !businessConnectionId) {
    return undefined;
  }

  const conversationKey = conversationKeyForMessage(
    source,
    input.message.chat.id,
    input.message.message_thread_id,
    businessConnectionId,
  );
  if (!conversationKey) {
    return undefined;
  }

  const text = input.text;
  const replyUsername = replyToBotUsername(input.message);
  const message: TelegramInboundMessage = {
    id: `telegram:${input.update.update_id}:${input.idSuffix}`,
    updateId: input.update.update_id,
    conversationKey,
    source,
    chatId: input.message.chat.id,
    ...(input.user?.id !== undefined ? { userId: input.user.id } : {}),
    messageId: input.message.message_id,
    ...(text !== undefined ? { text, redactedText: redactSecrets(text) } : {}),
    ...(input.user ? { actor: actorForUser(input.user, input.config) } : {}),
    ...(businessConnectionId ? { businessConnectionId } : {}),
    ...(replyUsername ? { replyToBotUsername: replyUsername, isReplyToBot: true } : {}),
    receivedAt: new Date(input.message.date * 1000).toISOString(),
  };

  return { message };
};

const sourceForChat = (
  chatType: NonNullable<TelegramUpdate["message"]>["chat"]["type"],
): TelegramConversationSource | undefined => {
  if (chatType === "private") {
    return "bot_private";
  }
  if (chatType === "group" || chatType === "supergroup") {
    return "group";
  }
  return undefined;
};

const conversationKeyForMessage = (
  source: TelegramConversationSource,
  chatId: number,
  messageThreadId: number | undefined,
  businessConnectionId: string | undefined,
): string | undefined => {
  if (source === "bot_private") {
    return `bot_private:${chatId}`;
  }
  if (source === "group") {
    return `group:${chatId}:${messageThreadId ?? "main"}`;
  }
  if (source === "business" && businessConnectionId) {
    return `business:${businessConnectionId}:${chatId}`;
  }
  return undefined;
};

const actorForUser = (
  user: NonNullable<NonNullable<TelegramUpdate["message"]>["from"]>,
  config: TelegramAssistantConfig,
): TelegramAssistantActor => ({
  telegramUserId: user.id,
  ...(user.username ? { username: user.username } : {}),
  displayName: [user.first_name, user.last_name].filter(Boolean).join(" "),
  role: roleForUser(user.id, config),
});

const roleForUser = (
  userId: number,
  config: TelegramAssistantConfig,
): TelegramAssistantRole => {
  return resolveTelegramRole(config, userId);
};

const replyToBotUsername = (
  message: NonNullable<TelegramUpdate["message"]>,
): string | undefined => {
  const replyToUser = message.reply_to_message?.from;
  if (replyToUser?.is_bot !== true) {
    return undefined;
  }
  return replyToUser.username;
};

const addDays = (isoDate: string, days: number): string => {
  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + Math.max(0, days));
  return date.toISOString();
};

const errorToMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};
