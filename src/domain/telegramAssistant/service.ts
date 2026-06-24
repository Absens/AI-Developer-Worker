import type { Dirent } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  TelegramAnswerCallbackQueryInput,
  TelegramClient,
  TelegramMessage,
  TelegramSendMessageInput,
  TelegramUpdate,
} from "../../integrations/telegram/index.js";
import { TelegramRetryAfterError } from "../../integrations/telegram/index.js";
import type { TelegramPhotoSize } from "../../integrations/telegram/types.js";
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
import type { ObservabilityTelemetry } from "../../observability/service.js";
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
import { validateTelegramAttachment } from "./media.js";
import { canHandleBusinessMessage } from "./profileAutomation.js";
import {
  buildTelegramExecutableTaskDraft,
  nextExecutableDraftQuestion,
} from "./executableTaskDraft.js";
import {
  resolveTelegramExecutionRepositoryProfile,
  type TelegramExecutionRepositoryProfile,
} from "./repositoryProfileResolver.js";
import type {
  AnswerProjectQuestionResult,
  AssistantSource,
  TelegramAssistantCodexService,
} from "./assistantCodex.js";
import { encryptTelegramAuditText } from "./auditCrypto.js";
import type { TelegramAssistantProjectSourceProvider } from "./projectSources.js";
import type {
  PurgeDigitalTwinSessionDataResult,
  TelegramAssistantStore,
} from "./store.js";
import {
  buildHeuristicTaskDraft,
  type TelegramTaskDraft,
} from "./taskDraftBuilder.js";
import { summarizeTaskForTelegram } from "./taskSummaries.js";
import type {
  TelegramAssistantActor,
  TelegramAttachmentMetadata,
  TelegramBusinessConnectionRecord,
  TelegramConversationSource,
  TelegramDigitalTwinSession,
  TelegramExecutableTaskDraft,
  TelegramExecutableTaskDraftExecutionMode,
  TelegramExecutableTaskDraftQuestion,
  TelegramExecutableTaskDraftSession,
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
  assistantCodex?: Partial<Pick<
    TelegramAssistantCodexService,
    "answerProjectQuestion" | "answerAsDigitalTwin"
  >>;
  projectSourceProvider?: TelegramAssistantProjectSourceProvider;
  repositories: RepositoryProfile[];
  telegram: Pick<TelegramClient, "sendMessage" | "answerCallbackQuery">;
  notificationRouter?: Pick<TelegramNotificationRouter, "scanSubscribedTasks">;
  observability?: Pick<
    ObservabilityTelemetry,
    "incrementCounter" | "observeHistogram" | "setGauge"
  >;
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

interface AfterConversationLockOperation {
  run(): Promise<void>;
  runInBackground?: boolean;
  preserveQueuedMessage?: boolean;
}

interface MessageProcessingOptions {
  drainAfterProjectTurn?: boolean;
  fromQueuedMessage?: boolean;
}

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
const BUSINESS_REPLY_UNAVAILABLE_OWNER_MESSAGE =
  "Не могу ответить клиенту через бизнес-чат: у подключения нет права can_reply.";
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
const PROJECT_QA_UNAVAILABLE_MESSAGE = "Проектный Q&A сейчас недоступен.";
const PROJECT_QA_NO_SOURCES_MESSAGE =
  "Не нашел проектный контекст для ответа. Уточни репозиторий или добавь документацию.";
const ANSWER_QUESTION_NOT_FOUND_MESSAGE =
  "Не нашел открытый вопрос AI. Уточни задачу или дождись вопроса.";
const ANSWER_QUESTION_AMBIGUOUS_MESSAGE =
  "Нашел несколько открытых вопросов AI. Уточни task id или ответь из карточки задачи.";
const ANSWER_QUESTION_CONFIRMATION_UNAVAILABLE_MESSAGE =
  "Не могу ответить на вопрос: не удалось определить сообщение или пользователя.";
const ANSWER_RECORDED_MESSAGE = "Ответ записан. Задача продолжит работу.";
const TASK_CREATION_DAILY_LIMIT_MESSAGE = "Дневной лимит создания задач исчерпан.";
const PROJECT_QA_DAILY_LIMIT_MESSAGE = "Дневной лимит проектного Q&A исчерпан.";
const PROJECT_SOURCE_ROOT_FILES = ["README.md", "AGENTS.md", "product_roadmap.md"];
const MAX_PROJECT_SOURCE_FILES = 20;
const MAX_PROJECT_SOURCE_FILE_CHARS = 8_000;
const MAX_TASK_SOURCE_COUNT = 5;

export class TelegramAssistantService {
  private readonly store: TelegramAssistantStore;
  private readonly config: TelegramAssistantConfig;
  private readonly taskTracker?: TaskTrackerClient;
  private readonly assistantCodex?: Partial<Pick<
    TelegramAssistantCodexService,
    "answerProjectQuestion" | "answerAsDigitalTwin"
  >>;
  private readonly projectSourceProvider?: TelegramAssistantProjectSourceProvider;
  private readonly repositories: RepositoryProfile[];
  private readonly telegram: Pick<TelegramClient, "sendMessage" | "answerCallbackQuery">;
  private readonly notificationRouter?: Pick<
    TelegramNotificationRouter,
    "scanSubscribedTasks"
  >;
  private readonly observability?: Pick<
    ObservabilityTelemetry,
    "incrementCounter" | "observeHistogram" | "setGauge"
  >;
  private readonly logger?: TelegramAssistantLogger;
  private readonly botUsername?: string;

  public constructor(options: TelegramAssistantServiceOptions) {
    this.store = options.store;
    this.config = options.config;
    this.taskTracker = options.taskTracker;
    this.assistantCodex = options.assistantCodex;
    this.projectSourceProvider = options.projectSourceProvider;
    this.repositories = options.repositories;
    this.telegram = options.telegram;
    this.notificationRouter = options.notificationRouter;
    this.observability = options.observability;
    this.logger = options.logger;
    this.botUsername = options.botUsername ?? this.config.botUsername;
  }

  public async scanNotifications(): Promise<void> {
    await this.notificationRouter?.scanSubscribedTasks();
  }

  public async purgeConversationData(input: {
    conversationKey: string;
    requestedByUserId: number;
  }): Promise<{
    messageRefs: number;
    queuedMessages: number;
    assistantTurns: number;
    pendingActions: number;
    digitalTwin: PurgeDigitalTwinSessionDataResult;
  }> {
    this.assertTelegramAdmin(input.requestedByUserId, "purge");
    const [assistant, digitalTwin] = await Promise.all([
      this.store.purgeTelegramConversationData({
        conversationKey: input.conversationKey,
      }),
      this.store.purgeDigitalTwinSessionData(input.conversationKey),
    ]);
    return { ...assistant, digitalTwin };
  }

  public async pauseDigitalTwinSession(input: {
    sessionKey: string;
    requestedByUserId: number;
    reason?: string;
  }): Promise<void> {
    this.assertTelegramAdmin(input.requestedByUserId, "pause digital twin session");
    const existing = await this.store.getDigitalTwinSession(input.sessionKey);
    if (!existing) {
      return;
    }
    await this.store.upsertDigitalTwinSession({
      ...existing,
      status: "paused",
      statusReason: input.reason ?? "Paused by owner/admin.",
      updatedAt: new Date().toISOString(),
    });
  }

  public async resetDigitalTwinSession(input: {
    sessionKey: string;
    requestedByUserId: number;
  }): Promise<void> {
    this.assertTelegramAdmin(input.requestedByUserId, "reset digital twin session");
    const existing = await this.store.getDigitalTwinSession(input.sessionKey);
    if (!existing) {
      return;
    }
    const { codexThreadId: _codexThreadId, ...sessionWithoutThread } = existing;
    await this.store.upsertDigitalTwinSession({
      ...sessionWithoutThread,
      status: "reset_requested",
      statusReason: "Reset by owner/admin.",
      updatedAt: new Date().toISOString(),
    });
  }

  public async handleUpdate(update: TelegramUpdate): Promise<void> {
    const intent = this.intentNameForUpdate(update);
    const startedAt = Date.now();
    this.incrementMetric("telegram_updates_received_total");
    try {
      await this.handleUpdateInternal(update);
      this.incrementMetric("telegram_updates_processed_total", { outcome: "success" });
      this.incrementMetric("telegram_intents_total", {
        intent,
        outcome: "success",
      });
    } catch (error) {
      this.incrementMetric("telegram_updates_processed_total", { outcome: "failure" });
      this.incrementMetric("telegram_intents_total", {
        intent,
        outcome: "failure",
      });
      throw error;
    } finally {
      this.observability?.observeHistogram(
        "telegram_processing_duration_seconds",
        { intent },
        Math.max(0, Date.now() - startedAt) / 1000,
      );
    }
  }

  private assertTelegramAdmin(userId: number, action: string): void {
    if (resolveTelegramRole(this.config, userId) !== "admin") {
      throw new Error(`Telegram assistant ${action} requires an admin user.`);
    }
  }

  private async handleUpdateInternal(update: TelegramUpdate): Promise<void> {
    const processed = await this.store.withUpdateProcessing(update.update_id, async () => {
      await this.handleUnprocessedUpdate(update);
    });
    if (!processed) {
      await this.saveOffsetAfter(update.update_id);
    }
  }

  private async handleUnprocessedUpdate(update: TelegramUpdate): Promise<void> {
    if (update.business_connection) {
      try {
        await this.handleBusinessConnectionUpdate(
          update.business_connection,
          update.update_id,
        );
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

    if (update.deleted_business_messages) {
      try {
        await this.handleDeletedBusinessMessagesUpdate(update);
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

    if (update.edited_business_message) {
      try {
        await this.handleEditedBusinessMessageUpdate(update);
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
    if (this.isMessageStale(message)) {
      this.logStaleMessageSkipped(message);
      await this.markProcessedAndAdvance(update.update_id);
      return;
    }

    if (message.source === "business") {
      try {
        let afterConversationLock: AfterConversationLockOperation | undefined;
        await this.store.withConversationLock(
          message.conversationKey,
          async () => {
            afterConversationLock = await this.handleBusinessMessageUnderPolicy(
              message,
            );
          },
        );
        if (afterConversationLock && !afterConversationLock.runInBackground) {
          await afterConversationLock.run();
        }
        await this.markProcessedAndAdvance(update.update_id);
        if (afterConversationLock?.runInBackground) {
          this.runAfterConversationLockInBackground(
            afterConversationLock,
            update.update_id,
          );
        }
      } catch (error) {
        this.logger?.warn("Telegram assistant failed to handle update.", redactSecrets({
          updateId: update.update_id,
          error: errorToMessage(error),
        }));
        throw error;
      }
      return;
    }

    try {
      let afterConversationLock: AfterConversationLockOperation | undefined;
      await this.store.withConversationLock(
        message.conversationKey,
        async () => {
          afterConversationLock = await this.handleMessageUnderConversationLock(
            message,
          );
        },
      );
      if (afterConversationLock && !afterConversationLock.runInBackground) {
        await afterConversationLock.run();
      }
      await this.markProcessedAndAdvance(update.update_id);
      if (afterConversationLock?.runInBackground) {
        this.runAfterConversationLockInBackground(
          afterConversationLock,
          update.update_id,
        );
      }
    } catch (error) {
      this.logger?.warn("Telegram assistant failed to handle update.", redactSecrets({
        updateId: update.update_id,
        error: errorToMessage(error),
      }));
      throw error;
    }
  }

  private async handleMessageUnderConversationLock(
    message: TelegramInboundMessage,
    options: MessageProcessingOptions = {},
  ): Promise<AfterConversationLockOperation | undefined> {
    if (!this.config.enabled) {
      return undefined;
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
      return undefined;
    }

    const intent = routeTelegramIntent(message.text, {
      projectQaEnabled: this.isProjectQaEnabledForMessage(message),
    });
    const actor = resolveTelegramActor(this.config, message);
    const projectQuestionAllowedByProfile =
      intent.name === "project_question" &&
      message.source === "business" &&
      (await this.isProjectQuestionAllowedForMessage(message));
    const profileOwnerApprovalAllowed =
      (intent.name === "approve_action" || intent.name === "reject_action") &&
      message.source === "bot_private" &&
      message.userId !== undefined &&
      this.config.profileAutomation.allowedOwnerIds.includes(String(message.userId));
    if (
      !actor.allowed &&
      !projectQuestionAllowedByProfile &&
      !profileOwnerApprovalAllowed
    ) {
      await this.sendMessage({
        chatId: String(message.chatId),
        text: UNAUTHORIZED_MESSAGE,
        ...(message.businessConnectionId
          ? { businessConnectionId: message.businessConnectionId }
          : {}),
      });
      return undefined;
    }

    await this.recordMessageRef(message);

    const activeTurn = await this.store.getActiveAssistantTurn(
      message.conversationKey,
    );
    if (activeTurn) {
      if (intent.name === "reject_action") {
        await this.cancelActiveAssistantTurn(message, activeTurn.id);
        return undefined;
      }
      await this.enqueueMessage(message);
      return undefined;
    }

    if (
      intent.safetyLevel === "confirm_write" &&
      !canPerformTelegramWrite(actor) &&
      !profileOwnerApprovalAllowed
    ) {
      await this.sendMessage({
        chatId: String(message.chatId),
        text: WRITE_ROLE_REQUIRED_MESSAGE,
        ...(message.messageId
          ? { replyToMessageId: message.messageId }
          : {}),
        ...(message.businessConnectionId
          ? { businessConnectionId: message.businessConnectionId }
          : {}),
      });
      return undefined;
    }

    if (intent.name === "task_status") {
      await this.handleTaskStatus(message, intent.rawText ?? message.text ?? "");
      return undefined;
    }

    if (intent.name === "project_question") {
      return this.prepareProjectQuestionTurn(
        message,
        intent.rawText ?? message.text ?? "",
        options,
      );
    }

    if (intent.name === "create_task_draft") {
      await this.handleCreateTaskDraft(
        message,
        intent,
        message.text ?? intent.rawText ?? "",
      );
      return undefined;
    }

    if (intent.name === "answer_ai_question") {
      await this.handleAnswerAiQuestion(
        message,
        intent,
        intent.rawText ?? message.text ?? "",
      );
      return undefined;
    }

    if (intent.name === "approve_action") {
      await this.handleApproveAction(message);
      return undefined;
    }

    if (intent.name === "reject_action") {
      await this.handleRejectAction(message);
      return undefined;
    }

    await this.sendPlainMessage(message, `Intent: ${intent.name}`);
    return undefined;
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
        const profileOwnerCallbackAllowed =
          !canPerformTelegramWrite(actor) &&
          await this.isProfileOwnerPendingActionCallbackAllowed(
            candidate.message,
            parsed,
          );
        if (!actor.allowed && !profileOwnerCallbackAllowed) {
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
          { profileOwnerCallbackAllowed },
        );
      },
    );
  }

  private async handleConfirmCallback(
    callbackQueryId: string,
    message: TelegramInboundMessage,
    actor: TelegramResolvedActor,
    callback: Extract<ParsedTelegramCallbackData, { kind: "confirm" }>,
    options: { profileOwnerCallbackAllowed?: boolean } = {},
  ): Promise<void> {
    if (!isSupportedConfirmActionKind(callback.actionKind)) {
      await this.answerCallback(callbackQueryId, CALLBACK_INVALID_MESSAGE);
      return;
    }

    if (!canPerformTelegramWrite(actor) && !options.profileOwnerCallbackAllowed) {
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

  private async handleBusinessConnectionUpdate(
    connection: NonNullable<TelegramUpdate["business_connection"]>,
    updateId: number,
  ): Promise<void> {
    const eventAt = new Date(connection.date * 1000).toISOString();
    const existing = await this.store.getBusinessConnection(connection.id);
    const rights = {
      ...(connection.rights ?? {}),
      can_reply: connection.rights?.can_reply ?? connection.can_reply ?? false,
    };
    await this.store.upsertBusinessConnection({
      businessConnectionId: connection.id,
      ownerUserId: String(connection.user.id),
      ownerChatId: String(connection.user_chat_id),
      rights,
      isEnabled: connection.is_enabled,
      createdAt: existing?.createdAt ?? eventAt,
      updatedAt: eventAt,
      lastSeenAt: eventAt,
      updateId,
    });
  }

  private async handleDeletedBusinessMessagesUpdate(
    update: TelegramUpdate,
  ): Promise<void> {
    const deleted = update.deleted_business_messages;
    if (!deleted) {
      return;
    }

    const conversationKey = conversationKeyForMessage(
      "business",
      deleted.chat.id,
      undefined,
      deleted.business_connection_id,
    );
    if (!conversationKey) {
      return;
    }

    const now = new Date().toISOString();
    for (const messageId of deleted.message_ids) {
      await this.store.recordMessageRef({
        id: `message-ref:${update.update_id}:deleted-business-message:${messageId}`,
        conversationKey,
        chatId: deleted.chat.id,
        messageId,
        source: "system",
        redactedText: "[deleted business message]",
        createdAt: now,
        expiresAt: addDays(now, this.config.conversationRetentionDays),
      });
    }
  }

  private async handleEditedBusinessMessageUpdate(
    update: TelegramUpdate,
  ): Promise<void> {
    const message = normalizeTelegramUpdate(update, this.config);
    if (!message || message.source !== "business") {
      return;
    }

    await this.recordMessageRef(message);
  }

  private async handleBusinessMessageUnderPolicy(
    message: TelegramInboundMessage,
    options: MessageProcessingOptions = {},
  ): Promise<AfterConversationLockOperation | undefined> {
    await this.recordMessageRef(message);

    const connection = message.businessConnectionId
      ? await this.store.getBusinessConnection(message.businessConnectionId)
      : undefined;
    const policy = canHandleBusinessMessage(this.config, message, connection);
    if (!policy.allowed || !connection) {
      this.logger?.info("Telegram business message saved without automation.", {
        reason: policy.reason ?? "missing connection",
        conversationKey: message.conversationKey,
      });
      return undefined;
    }

    const intent = routeTelegramIntent(message.text, {
      projectQaEnabled: this.config.profileAutomation.projectQaEnabled,
    });

    const activeTurn = await this.store.getActiveAssistantTurn(
      message.conversationKey,
    );
    if (activeTurn) {
      if (intent.name === "reject_action") {
        await this.cancelActiveAssistantTurn(message, activeTurn.id);
        return undefined;
      }
      await this.enqueueMessage(message);
      return undefined;
    }

    if (
      message.source === "business" &&
      this.config.digitalTwin.enabled &&
      this.config.digitalTwin.autoReplyEnabled &&
      policy.shouldAutoReply &&
      policy.canReply &&
      this.assistantCodex?.answerAsDigitalTwin
    ) {
      return this.prepareDigitalTwinTurn(message, connection, options);
    }

    if (intent.name === "task_status") {
      if (!policy.shouldAutoReply) {
        return undefined;
      }
      if (!policy.canReply) {
        await this.notifyOwnerBusinessReplyUnavailable(connection, message);
        return undefined;
      }
      await this.handleTaskStatus(message, intent.rawText ?? message.text ?? "");
      return undefined;
    }

    if (intent.name === "create_task_draft") {
      if (this.config.profileAutomation.requireOwnerApproval) {
        await this.handleBusinessCreateTaskDraftForOwnerApproval(
          message,
          connection,
          intent,
          intent.rawText ?? message.text ?? "",
        );
      } else if (policy.shouldAutoReply && !policy.canReply) {
        await this.notifyOwnerBusinessReplyUnavailable(connection, message);
      }
      return undefined;
    }

    if (intent.name === "project_question") {
      if (
        !policy.shouldAutoReply ||
        !this.config.profileAutomation.projectQaEnabled
      ) {
        return undefined;
      }
      if (!policy.canReply) {
        await this.notifyOwnerBusinessReplyUnavailable(connection, message);
        return undefined;
      }
      return this.prepareProjectQuestionTurn(
        message,
        intent.rawText ?? message.text ?? "",
        options,
      );
    }

    if (!policy.shouldAutoReply) {
      return undefined;
    }
    if (!policy.canReply) {
      await this.notifyOwnerBusinessReplyUnavailable(connection, message);
      return undefined;
    }

    await this.sendPlainMessage(message, `Intent: ${intent.name}`);
    return undefined;
  }

  private async isProfileOwnerPendingActionCallbackAllowed(
    message: TelegramInboundMessage,
    callback: ParsedTelegramCallbackData,
  ): Promise<boolean> {
    if (
      message.source !== "bot_private" ||
      message.userId === undefined ||
      !this.config.profileAutomation.allowedOwnerIds.includes(String(message.userId))
    ) {
      return false;
    }
    if (callback.kind === "select_task") {
      return false;
    }

    const action = await this.store.getPendingAction(callback.id);
    if (
      !action ||
      action.chatId !== message.chatId ||
      action.userId !== message.userId ||
      !isOwnerRoutedBusinessTaskDraftAction(action)
    ) {
      return false;
    }
    if (callback.kind === "confirm") {
      return isConfirmableActionForCallback(action, callback.actionKind);
    }
    return isConfirmablePendingAction(action);
  }

  private async notifyOwnerBusinessReplyUnavailable(
    connection: TelegramBusinessConnectionRecord,
    message: TelegramInboundMessage,
  ): Promise<void> {
    await this.sendOwnerPlainMessage(
      connection,
      BUSINESS_REPLY_UNAVAILABLE_OWNER_MESSAGE,
    );
    this.logger?.info("Telegram business message owner notified without automation reply.", {
      conversationKey: message.conversationKey,
      businessConnectionId: message.businessConnectionId,
    });
  }

  private async handleBusinessCreateTaskDraftForOwnerApproval(
    message: TelegramInboundMessage,
    connection: TelegramBusinessConnectionRecord,
    intent: TelegramIntent,
    text: string,
  ): Promise<void> {
    if (!this.taskTracker) {
      await this.sendOwnerPlainMessage(
        connection,
        TASK_CREATION_UNAVAILABLE_MESSAGE,
      );
      return;
    }
    if (message.messageId === undefined || message.userId === undefined) {
      await this.sendOwnerPlainMessage(
        connection,
        "Не могу создать задачу: не удалось определить сообщение или пользователя.",
      );
      return;
    }
    const ownerMessage = this.buildOwnerApprovalMessage(message, connection);
    if (await this.isTaskCreationRateLimited(ownerMessage.userId!)) {
      await this.sendOwnerPlainMessage(connection, TASK_CREATION_DAILY_LIMIT_MESSAGE);
      this.incrementMetric("telegram_rate_limited_total", { direction: "inbound" });
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
      conversationKey: ownerMessage.conversationKey,
      chatId: ownerMessage.chatId,
      userId: ownerMessage.userId!,
      intent,
      payload: {
        draft,
        chatId: message.chatId,
        messageId: message.messageId,
        userId: message.userId,
        externalKey,
        ...(message.attachments && message.attachments.length > 0
          ? { attachments: message.attachments }
          : {}),
      },
      status: "pending",
      createdAt: now,
      updatedAt: now,
      expiresAt: addDays(now, this.config.conversationRetentionDays),
    };

    await this.store.upsertPendingAction(pendingAction);
    await this.updatePendingActionGauges();
    await this.sendTelegramResponse(
      ownerMessage,
      buildTaskDraftResponse(draft, pendingAction.id),
    );
  }

  private buildOwnerApprovalMessage(
    message: TelegramInboundMessage,
    connection: TelegramBusinessConnectionRecord,
  ): TelegramInboundMessage {
    const ownerChatId = Number(connection.ownerChatId);
    const ownerUserId = Number(connection.ownerUserId);
    return {
      ...message,
      id: `${message.id}:owner-approval`,
      conversationKey: `bot_private:${connection.ownerChatId}`,
      source: "bot_private",
      chatId: ownerChatId,
      userId: ownerUserId,
      businessConnectionId: undefined,
      actor: {
        telegramUserId: ownerUserId,
        role: resolveTelegramRole(this.config, ownerUserId),
      },
    };
  }

  private async sendOwnerPlainMessage(
    connection: TelegramBusinessConnectionRecord,
    text: string,
  ): Promise<void> {
    await this.sendMessage({
      chatId: connection.ownerChatId,
      text,
    });
  }

  private async handleCreateTaskDraft(
    message: TelegramInboundMessage,
    intent: TelegramIntent,
    text: string,
  ): Promise<void> {
    if (!this.config.taskCreationEnabled) {
      await this.sendPlainMessage(
        message,
        "Создание задач через Telegram сейчас выключено.",
      );
      return;
    }
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
    if (await this.isTaskCreationRateLimited(message.userId)) {
      await this.sendPlainMessage(message, TASK_CREATION_DAILY_LIMIT_MESSAGE);
      this.incrementMetric("telegram_rate_limited_total", { direction: "inbound" });
      return;
    }

    const draftText = message.text ?? text;
    const repositoryResolution = resolveTelegramExecutionRepositoryProfile({
      text: draftText,
      repositories: this.repositories,
      defaultRepository: this.config.defaultRepository,
    });
    const now = new Date().toISOString();

    if (repositoryResolution.status === "unavailable") {
      await this.sendPlainMessage(
        message,
        "Не могу поставить задачу в очередь: не настроен repository profile для выполнения.",
      );
      return;
    }

    if (repositoryResolution.status === "needs_selection") {
      const clarificationQuestion: TelegramExecutableTaskDraftQuestion = {
        field: "repositoryProfile",
        text: "В каком репозитории выполнить задачу?",
      };
      await this.store.upsertExecutableTaskDraftSession({
        id: buildExecutableDraftSessionId(message.updateId, message.messageId),
        conversationKey: message.conversationKey,
        source: "private",
        initiatorUserId: message.userId,
        chatId: message.chatId,
        messageId: message.messageId,
        originalText: draftText,
        draft: this.buildPrivateExecutableTaskDraft(draftText),
        status: "collecting",
        clarificationQuestion,
        clarificationHistory: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: addDays(now, this.config.conversationRetentionDays),
      });
      await this.sendPlainMessage(
        message,
        "В каком репозитории выполнить задачу? Ответь названием репозитория или queue.",
      );
      return;
    }

    const draft = this.buildPrivateExecutableTaskDraft(
      draftText,
      repositoryResolution.profile,
    );
    const clarificationQuestion = nextExecutableDraftQuestion(draft);
    const session: TelegramExecutableTaskDraftSession = {
      id: buildExecutableDraftSessionId(message.updateId, message.messageId),
      conversationKey: message.conversationKey,
      chatId: message.chatId,
      messageId: message.messageId,
      source: "private",
      initiatorUserId: message.userId,
      originalText: draftText,
      draft,
      status: clarificationQuestion ? "collecting" : "awaiting_user_confirmation",
      ...(clarificationQuestion ? { clarificationQuestion } : {}),
      clarificationHistory: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: addDays(now, this.config.conversationRetentionDays),
    };
    await this.store.upsertExecutableTaskDraftSession(session);

    if (clarificationQuestion) {
      await this.sendPlainMessage(message, clarificationQuestion.text);
      return;
    }

    const pendingAction = createExecutableTaskPendingActionFromSession(
      message,
      intent,
      session,
    );
    await this.store.upsertPendingAction(pendingAction);
    await this.updatePendingActionGauges();
    await this.sendTelegramResponse(
      message,
      buildExecutableTaskDraftResponse(draft, pendingAction.id),
    );
  }

  private buildPrivateExecutableTaskDraft(
    text: string,
    selectedProfile?: TelegramExecutionRepositoryProfile,
  ): TelegramExecutableTaskDraft {
    const draft = buildTelegramExecutableTaskDraft({
      text,
      ...(selectedProfile ? { selectedProfile } : {}),
    });
    const heuristicTitle = buildHeuristicTaskDraft(
      text,
      this.repositories,
      this.config.defaultRepository,
    ).title;
    return {
      ...draft,
      title: heuristicTitle,
      description: text,
    };
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
    await this.updatePendingActionGauges();
    await this.sendTelegramResponse(
      message,
      buildAnswerAiQuestionResponse(
        candidateResolution.candidate,
        body,
        pendingAction.id,
      ),
    );
  }

  private async prepareProjectQuestionTurn(
    message: TelegramInboundMessage,
    text: string,
    options: MessageProcessingOptions = {},
  ): Promise<AfterConversationLockOperation | undefined> {
    if (
      !this.isProjectQaEnabledForMessage(message) ||
      !this.assistantCodex?.answerProjectQuestion ||
      !(await this.isProjectQuestionAllowedForMessage(message))
    ) {
      await this.sendPlainMessage(message, PROJECT_QA_UNAVAILABLE_MESSAGE);
      return undefined;
    }
    if (
      message.userId !== undefined &&
      await this.isCodexQaRateLimited(message.userId)
    ) {
      await this.sendPlainMessage(message, PROJECT_QA_DAILY_LIMIT_MESSAGE);
      this.incrementMetric("telegram_rate_limited_total", { direction: "inbound" });
      return undefined;
    }

    const now = new Date().toISOString();
    const turnId = buildAssistantTurnId(message);
    await this.store.startAssistantTurn({
      id: turnId,
      conversationKey: message.conversationKey,
      status: "running",
      startedAt: now,
      input: toPersistableInboundMessage(message),
    });

    return {
      runInBackground: true,
      run: async () => {
        await this.runProjectQuestionTurn(
          message,
          turnId,
          text,
          options.drainAfterProjectTurn !== false,
        );
      },
    };
  }

  private async runProjectQuestionTurn(
    message: TelegramInboundMessage,
    turnId: string,
    text: string,
    drainAfterCompletion: boolean,
  ): Promise<void> {
    try {
      const question = redactSecrets(text.trim() || message.text?.trim() || "");
      const sources = await this.collectProjectQuestionSources(question);
      if (sources.length === 0) {
        const completed = await this.store.completeAssistantTurnIfRunning(turnId, {
          status: "completed",
          diagnostic: "No project sources were available.",
        });
        if (completed) {
          await this.sendPlainMessage(message, PROJECT_QA_NO_SOURCES_MESSAGE);
          if (drainAfterCompletion) {
            await this.drainQueuedMessages(message.conversationKey);
          }
        }
        return;
      }

      const result = await this.assistantCodex?.answerProjectQuestion?.({
        question,
        sources,
      });
      if (!result) {
        const completed = await this.store.completeAssistantTurnIfRunning(turnId, {
          status: "failed",
          diagnostic: PROJECT_QA_UNAVAILABLE_MESSAGE,
        });
        if (completed) {
          await this.sendPlainMessage(message, PROJECT_QA_UNAVAILABLE_MESSAGE);
        }
        return;
      }
      const completed = await this.completeProjectQuestionTurn(turnId, result);
      if (!completed) {
        return;
      }
      this.incrementMetric("telegram_codex_turns_total", {
        intent: "project_question",
        outcome: result.timedOut === true ? "failed" : "success",
      });

      await this.sendPlainMessage(message, result.answer);
      if (drainAfterCompletion) {
        await this.drainQueuedMessages(message.conversationKey);
      }
    } catch (error) {
      await this.store.completeAssistantTurnIfRunning(turnId, {
        status: "failed",
        diagnostic: redactSecrets(errorToMessage(error)),
      });
      this.incrementMetric("telegram_codex_turns_total", {
        intent: "project_question",
        outcome: "failure",
      });
      throw error;
    }
  }

  private async completeProjectQuestionTurn(
    turnId: string,
    result: AnswerProjectQuestionResult,
  ): Promise<boolean> {
    const completed = await this.store.completeAssistantTurnIfRunning(turnId, {
      status: result.timedOut === true ? "failed" : "completed",
      ...(result.threadId ? { threadId: result.threadId } : {}),
      ...(result.timedOut === true ? { diagnostic: "Assistant Codex timed out." } : {}),
    });
    return completed !== undefined;
  }

  private async prepareDigitalTwinTurn(
    message: TelegramInboundMessage,
    connection: TelegramBusinessConnectionRecord,
    options: MessageProcessingOptions = {},
  ): Promise<AfterConversationLockOperation | undefined> {
    if (!message.businessConnectionId || message.messageId === undefined) {
      return undefined;
    }

    const sessionKey = message.conversationKey;
    return this.store.withDigitalTwinSessionLock(sessionKey, async () => {
      const now = new Date().toISOString();
      const session = await this.prepareDigitalTwinSessionForInbound({
        message,
        connection,
        now,
      });
      const inboundMessageKey = buildDigitalTwinInboundMessageKey(message);
      const outboundMessageKey = buildDigitalTwinOutboundMessageKey(message);

      if (session.status === "paused") {
        const inboundFullTextEncrypted = this.encryptDigitalTwinAuditText(
          message.text,
        );
        await this.store.reserveDigitalTwinMessage({
          id: buildDigitalTwinInboundMessageId(message),
          sessionKey,
          messageKey: inboundMessageKey,
          telegramUpdateId: message.updateId,
          direction: "inbound",
          telegramMessageId: message.messageId,
          deliveryStatus: "received",
          redactedText: message.redactedText,
          fullTextEncrypted: inboundFullTextEncrypted,
          createdAt: now,
          metadata: { paused: true },
        });
        return undefined;
      }

      const activeTurn = await this.store.getActiveDigitalTwinTurn(sessionKey);
      if (activeTurn) {
        if (options.fromQueuedMessage === true) {
          return {
            preserveQueuedMessage: true,
            run: async () => undefined,
          };
        }
        await this.enqueueMessage(message);
        return undefined;
      }

      const inboundFullTextEncrypted = this.encryptDigitalTwinAuditText(
        message.text,
      );
      const turnId = buildDigitalTwinTurnId(message);
      const turn = await this.store.startDigitalTwinTurn({
        id: turnId,
        sessionKey,
        inboundMessageKey,
        outboundMessageKey,
        status: "running",
        ...(session.codexThreadId ? { codexThreadId: session.codexThreadId } : {}),
        startedAt: now,
        metadata: {
          telegramUpdateId: message.updateId,
          telegramMessageId: message.messageId,
        },
      });
      if (!turn) {
        if (options.fromQueuedMessage === true) {
          return {
            preserveQueuedMessage: true,
            run: async () => undefined,
          };
        }
        await this.enqueueMessage(message);
        return undefined;
      }

      const inbound = await this.store.reserveDigitalTwinMessage({
        id: buildDigitalTwinInboundMessageId(message),
        sessionKey,
        messageKey: inboundMessageKey,
        telegramUpdateId: message.updateId,
        direction: "inbound",
        telegramMessageId: message.messageId,
        deliveryStatus: "received",
        redactedText: message.redactedText,
        fullTextEncrypted: inboundFullTextEncrypted,
        createdAt: now,
        metadata: {},
      });
      if (!inbound.inserted) {
        await this.store.completeDigitalTwinTurnIfRunning(turnId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          error: "Duplicate inbound digital twin message.",
        });
        return undefined;
      }

      const outbound = await this.store.reserveDigitalTwinMessage({
        id: buildDigitalTwinOutboundMessageId(message),
        sessionKey,
        messageKey: outboundMessageKey,
        telegramUpdateId: message.updateId,
        direction: "outbound",
        telegramMessageId: message.messageId,
        deliveryStatus: "generating",
        createdAt: now,
        metadata: {},
      });
      if (!outbound.inserted) {
        await this.store.completeDigitalTwinTurnIfRunning(turnId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          error: "Duplicate outbound digital twin message.",
        });
        return undefined;
      }

      return {
        runInBackground: true,
        run: async () => {
          await this.runDigitalTwinTurn(
            message,
            turnId,
            options.drainAfterProjectTurn !== false,
          );
        },
      };
    });
  }

  private async prepareDigitalTwinSessionForInbound(input: {
    message: TelegramInboundMessage;
    connection: TelegramBusinessConnectionRecord;
    now: string;
  }): Promise<TelegramDigitalTwinSession> {
    const existing = await this.store.getDigitalTwinSession(
      input.message.conversationKey,
    );
    if (!existing) {
      return this.store.upsertDigitalTwinSession({
        sessionKey: input.message.conversationKey,
        source: "business",
        chatId: input.message.chatId,
        businessConnectionId: input.connection.businessConnectionId,
        ownerUserId: input.connection.ownerUserId,
        ownerChatId: input.connection.ownerChatId,
        status: "active",
        personaProfileVersion: this.config.digitalTwin.personaProfileVersion,
        summaryNeedsRefresh: false,
        createdAt: input.now,
        updatedAt: input.now,
      });
    }

    if (existing.status === "paused") {
      return existing;
    }

    const ttlExpired = this.isDigitalTwinSessionTtlExpired(existing, input.now);
    const personaChanged =
      existing.personaProfileVersion !== this.config.digitalTwin.personaProfileVersion;
    const statusReason = existing.status === "reset_requested"
      ? "reset_requested"
      : ttlExpired
        ? "ttl_expired"
        : personaChanged
          ? "persona_changed"
          : undefined;

    if (!statusReason) {
      return existing;
    }

    const updated: TelegramDigitalTwinSession = {
      sessionKey: existing.sessionKey,
      source: "business",
      chatId: input.message.chatId,
      businessConnectionId: input.connection.businessConnectionId,
      ownerUserId: input.connection.ownerUserId,
      ownerChatId: input.connection.ownerChatId,
      status: "active",
      statusReason,
      personaProfileVersion: this.config.digitalTwin.personaProfileVersion,
      ...(existing.summary !== undefined ? { summary: existing.summary } : {}),
      ...(existing.summaryUpdatedAt !== undefined
        ? { summaryUpdatedAt: existing.summaryUpdatedAt }
        : {}),
      summaryNeedsRefresh: true,
      ...(existing.lastInboundAt !== undefined
        ? { lastInboundAt: existing.lastInboundAt }
        : {}),
      ...(existing.lastOutboundAt !== undefined
        ? { lastOutboundAt: existing.lastOutboundAt }
        : {}),
      ...(existing.lastError !== undefined ? { lastError: existing.lastError } : {}),
      createdAt: existing.createdAt,
      updatedAt: input.now,
    };
    return this.store.upsertDigitalTwinSession(updated);
  }

  private isDigitalTwinSessionTtlExpired(
    session: TelegramDigitalTwinSession,
    now: string,
  ): boolean {
    const ttlDays = Math.max(0, this.config.digitalTwin.sessionTtlDays);
    if (ttlDays <= 0) {
      return false;
    }
    const updatedAtMs = Date.parse(session.updatedAt);
    const nowMs = Date.parse(now);
    if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) {
      return false;
    }
    return nowMs - updatedAtMs > ttlDays * 24 * 60 * 60 * 1000;
  }

  private async runDigitalTwinTurn(
    message: TelegramInboundMessage,
    turnId: string,
    drainAfterCompletion: boolean,
  ): Promise<void> {
    const sessionKey = message.conversationKey;
    const outboundMessageKey = buildDigitalTwinOutboundMessageKey(message);
    let sendAttempted = false;
    let deliveryCommitted = false;
    let shouldDrainQueuedMessages = false;

    try {
      const session = await this.store.getDigitalTwinSession(sessionKey);
      if (!session || !this.assistantCodex?.answerAsDigitalTwin) {
        await this.store.updateDigitalTwinMessageDelivery({
          messageKey: outboundMessageKey,
          deliveryStatus: "send_failed",
          deliveryError: "Digital twin session or Codex adapter is unavailable.",
        });
        await this.store.completeDigitalTwinTurnIfRunning(turnId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: "Digital twin session or Codex adapter is unavailable.",
        });
        return;
      }

      const now = new Date().toISOString();
      const inboundText = redactSecrets(message.text?.trim() ?? "");
      const sources = await this.collectProjectQuestionSources(inboundText);
      const recentMessages = await this.store.listDigitalTwinMessages(sessionKey, {
        limit: this.config.digitalTwin.maxRecentMessages,
      });
      const result = await this.assistantCodex.answerAsDigitalTwin({
        sessionKey,
        ...(session.codexThreadId ? { threadId: session.codexThreadId } : {}),
        inboundText,
        ownerStylePrompt: this.config.digitalTwin.ownerStylePrompt,
        personaProfileVersion: session.personaProfileVersion,
        ...(session.summary ? { summary: session.summary } : {}),
        sources,
        recentMessages: recentMessages.map((recentMessage) => ({
          direction: recentMessage.direction,
          ...(recentMessage.redactedText !== undefined
            ? { redactedText: recentMessage.redactedText }
            : {}),
        })),
        now,
      });

      const answer = result.answer.trim();
      const redactedAnswer = redactSecrets(answer);
      const codexThreadId = result.threadId ?? session.codexThreadId;
      await this.store.updateDigitalTwinMessageDelivery({
        messageKey: outboundMessageKey,
        deliveryStatus: "generated",
        redactedText: redactedAnswer,
        fullTextEncrypted: this.encryptDigitalTwinAuditText(answer),
        ...(codexThreadId ? { codexThreadId } : {}),
      });

      const latestConnection = message.businessConnectionId
        ? await this.store.getBusinessConnection(message.businessConnectionId)
        : undefined;
      const latestPolicy = canHandleBusinessMessage(
        this.config,
        message,
        latestConnection,
      );
      if (!latestConnection || !latestPolicy.allowed || !latestPolicy.shouldAutoReply || !latestPolicy.canReply) {
        await this.store.updateDigitalTwinMessageDelivery({
          messageKey: outboundMessageKey,
          deliveryStatus: "skipped",
          deliveryError: latestPolicy.reason ?? "business replies unavailable",
          ...(codexThreadId ? { codexThreadId } : {}),
        });
        await this.store.completeDigitalTwinTurnIfRunning(turnId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          ...(codexThreadId ? { codexThreadId } : {}),
          error: latestPolicy.reason ?? "business replies unavailable",
        });
        return;
      }

      const deliveryAttemptedAt = new Date().toISOString();
      await this.store.updateDigitalTwinMessageDelivery({
        messageKey: outboundMessageKey,
        deliveryStatus: "sending",
        deliveryAttemptedAt,
        ...(codexThreadId ? { codexThreadId } : {}),
      });
      sendAttempted = true;
      const sent = await this.sendMessage({
        chatId: String(message.chatId),
        text: answer,
        ...(message.messageId ? { replyToMessageId: message.messageId } : {}),
        businessConnectionId: message.businessConnectionId,
      });

      const deliveredAt = new Date().toISOString();
      const allMessages = await this.store.listDigitalTwinMessages(sessionKey);
      const inboundCount = allMessages.filter(
        (digitalTwinMessage) => digitalTwinMessage.direction === "inbound",
      ).length;
      const refreshInterval = Math.max(
        0,
        Math.floor(this.config.digitalTwin.summaryRefreshMessageInterval),
      );
      const summaryNeedsRefresh =
        refreshInterval > 0 && inboundCount % refreshInterval === 0;

      await this.store.updateDigitalTwinMessageDelivery({
        messageKey: outboundMessageKey,
        deliveryStatus: "sent",
        deliveredAt,
        sentTelegramMessageId: sent.message_id,
        ...(codexThreadId ? { codexThreadId } : {}),
      });
      deliveryCommitted = true;

      const completed = await this.store.completeDigitalTwinTurnIfRunning(turnId, {
        status: result.timedOut === true ? "failed" : "completed",
        completedAt: deliveredAt,
        ...(codexThreadId ? { codexThreadId } : {}),
        ...(result.timedOut === true ? { error: "Assistant Codex timed out." } : {}),
      });
      if (!completed) {
        return;
      }

      await this.store.upsertDigitalTwinSession({
        ...session,
        status: "active",
        ...(codexThreadId ? { codexThreadId } : {}),
        lastInboundAt: message.receivedAt,
        lastOutboundAt: deliveredAt,
        summaryNeedsRefresh: session.summaryNeedsRefresh || summaryNeedsRefresh,
        updatedAt: deliveredAt,
      });

      shouldDrainQueuedMessages = drainAfterCompletion;
    } catch (error) {
      const deliveryStatus = sendAttempted
        ? "unknown_after_send_attempt"
        : "send_failed";
      const diagnostic = redactSecrets(errorToMessage(error));
      if (!deliveryCommitted) {
        await this.store.updateDigitalTwinMessageDelivery({
          messageKey: outboundMessageKey,
          deliveryStatus,
          deliveryError: diagnostic,
        });
      }
      await this.store.completeDigitalTwinTurnIfRunning(turnId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: diagnostic,
      });
      throw error;
    }

    if (shouldDrainQueuedMessages) {
      await this.drainQueuedMessages(message.conversationKey);
    }
  }

  private async cancelActiveAssistantTurn(
    message: TelegramInboundMessage,
    turnId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const cancelled = await this.store.completeAssistantTurnIfRunning(turnId, {
      status: "cancelled",
      completedAt: now,
    });
    if (!cancelled) {
      return;
    }
    this.incrementMetric("telegram_codex_turns_total", {
      intent: "project_question",
      outcome: "cancelled",
    });
    const cancelledQueued = await this.store.cancelQueuedMessages(message.conversationKey, {
      cancelledAt: now,
    });
    if (cancelledQueued.length > 0) {
      this.incrementMetric(
        "telegram_queued_messages_total",
        { outcome: "cancelled" },
        cancelledQueued.length,
      );
    }
    await this.sendPlainMessage(message, ACTION_CANCELLED_MESSAGE);
  }

  private isProjectQaEnabledForMessage(message: TelegramInboundMessage): boolean {
    return message.source === "business"
      ? this.config.profileAutomation.projectQaEnabled
      : this.config.projectQaEnabled;
  }

  private async isProjectQuestionAllowedForMessage(
    message: TelegramInboundMessage,
  ): Promise<boolean> {
    if (message.source !== "business") {
      return true;
    }

    if (!this.config.profileAutomation.projectQaEnabled) {
      return false;
    }

    const connection = message.businessConnectionId
      ? await this.store.getBusinessConnection(message.businessConnectionId)
      : undefined;
    const policy = canHandleBusinessMessage(this.config, message, connection);
    if (!policy.allowed) {
      return false;
    }

    return true;
  }

  private async collectProjectQuestionSources(
    question: string,
  ): Promise<AssistantSource[]> {
    const repositorySources = await this.collectRepositorySources();
    const taskSource = await this.collectTaskSource(question);
    const taskSources = taskSource ? [taskSource] : [];
    const providerSources = await this.collectProjectSourceProviderSources(question);
    const reservedSourceCount = Math.min(
      MAX_PROJECT_SOURCE_FILES,
      taskSources.length + providerSources.length,
    );
    return [
      ...repositorySources.slice(0, MAX_PROJECT_SOURCE_FILES - reservedSourceCount),
      ...taskSources,
      ...providerSources,
    ].slice(0, MAX_PROJECT_SOURCE_FILES);
  }

  private async collectProjectSourceProviderSources(
    question: string,
  ): Promise<AssistantSource[]> {
    if (!this.projectSourceProvider) {
      return [];
    }

    try {
      return (await this.projectSourceProvider.collectProjectSources({
        question,
        repositories: this.repositories,
      }))
        .map(sanitizeProjectSource)
        .filter((source): source is AssistantSource => source !== undefined);
    } catch (error) {
      this.logger?.warn("Failed to collect Telegram project context sources.", redactSecrets({
        error: errorToMessage(error),
      }));
      return [];
    }
  }

  private async collectRepositorySources(): Promise<AssistantSource[]> {
    const sources: AssistantSource[] = [];
    for (const repository of this.repositories) {
      if (sources.length >= MAX_PROJECT_SOURCE_FILES) {
        break;
      }

      const root = resolve(repository.repoPath);
      for (const fileName of PROJECT_SOURCE_ROOT_FILES) {
        if (sources.length >= MAX_PROJECT_SOURCE_FILES) {
          break;
        }
        const source = await this.readRepositorySource(
          repository.name,
          root,
          join(root, fileName),
        );
        if (source) {
          sources.push(source);
        }
      }

      await this.collectRepositoryMarkdownSources(
        repository.name,
        root,
        join(root, "docs"),
        sources,
      );
    }
    return sources;
  }

  private async collectRepositoryMarkdownSources(
    repositoryName: string,
    root: string,
    directory: string,
    sources: AssistantSource[],
    depth = 0,
  ): Promise<void> {
    if (sources.length >= MAX_PROJECT_SOURCE_FILES || depth > 4) {
      return;
    }
    const safeDirectory = await realPathWithinRoot(root, directory);
    if (!safeDirectory) {
      return;
    }

    let entries: Dirent<string>[];
    try {
      entries = await readdir(safeDirectory.candidate, { withFileTypes: true });
    } catch (error) {
      if (!isMissingFileError(error)) {
        this.logger?.warn("Failed to read Telegram project docs directory.", redactSecrets({
          directory,
          error: errorToMessage(error),
        }));
      }
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (sources.length >= MAX_PROJECT_SOURCE_FILES) {
        return;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }

      const entryPath = join(safeDirectory.candidate, entry.name);
      if (entry.isDirectory()) {
        await this.collectRepositoryMarkdownSources(
          repositoryName,
          root,
          entryPath,
          sources,
          depth + 1,
        );
        continue;
      }
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        const source = await this.readRepositorySource(repositoryName, root, entryPath);
        if (source) {
          sources.push(source);
        }
      }
    }
  }

  private async readRepositorySource(
    repositoryName: string,
    root: string,
    filePath: string,
  ): Promise<AssistantSource | undefined> {
    const safePath = await realPathWithinRoot(root, filePath);
    if (!safePath) {
      return undefined;
    }

    try {
      const content = await readFile(safePath.candidate, "utf8");
      const relativePath = toPosixPath(relative(safePath.root, safePath.candidate));
      return {
        id: `${repositoryName}:${relativePath}`,
        body: redactSecrets(content.slice(0, MAX_PROJECT_SOURCE_FILE_CHARS)),
      };
    } catch (error) {
      if (!isMissingFileError(error)) {
        this.logger?.warn("Failed to read Telegram project source.", redactSecrets({
          path: safePath.candidate,
          error: errorToMessage(error),
        }));
      }
      return undefined;
    }
  }

  private async collectTaskSource(
    question: string,
  ): Promise<AssistantSource | undefined> {
    if (!this.taskTracker) {
      return undefined;
    }

    try {
      const tasks = await this.taskTracker.listTasks({ limit: 100 });
      const selectedTasks = selectRelevantTasks(question, tasks);
      if (selectedTasks.length === 0) {
        return undefined;
      }

      return {
        id: "task-tracker:recent-or-matching-tasks",
        body: redactSecrets(selectedTasks.map(formatTaskSourceLine).join("\n")),
      };
    } catch (error) {
      this.logger?.warn("Failed to collect Telegram project task context.", redactSecrets({
        error: errorToMessage(error),
      }));
      return undefined;
    }
  }

  private async drainQueuedMessages(conversationKey: string): Promise<void> {
    const maxMessages = Math.max(1, this.config.maxQueuedMessagesPerChat);
    for (let processed = 0; processed < maxMessages; processed += 1) {
      const queuedMessage = await this.nextQueuedMessage(conversationKey);
      if (!queuedMessage) {
        return;
      }

      let afterConversationLock: AfterConversationLockOperation | undefined;
      let acceptedQueuedMessage = false;
      await this.store.withConversationLock(conversationKey, async () => {
        const activeTurn = await this.store.getActiveAssistantTurn(conversationKey);
        if (activeTurn) {
          return;
        }

        const currentQueuedMessage = await this.getQueuedMessageById(
          conversationKey,
          queuedMessage.id,
        );
        if (!currentQueuedMessage) {
          return;
        }

        if (this.isMessageStale(currentQueuedMessage.message)) {
          this.logStaleMessageSkipped(currentQueuedMessage.message, {
            queuedMessageId: currentQueuedMessage.id,
          });
          await this.store.deleteQueuedMessage(currentQueuedMessage.id);
          acceptedQueuedMessage = true;
          return;
        }

        afterConversationLock = await this.handleQueuedMessageUnderConversationLock(
          currentQueuedMessage.message,
          { drainAfterProjectTurn: false, fromQueuedMessage: true },
        );
        if (afterConversationLock?.preserveQueuedMessage === true) {
          return;
        }
        await this.store.deleteQueuedMessage(currentQueuedMessage.id);
        acceptedQueuedMessage = true;
      });

      if (!acceptedQueuedMessage) {
        return;
      }
      if (afterConversationLock) {
        await afterConversationLock.run();
      }
    }
  }

  private async handleQueuedMessageUnderConversationLock(
    message: TelegramInboundMessage,
    options: MessageProcessingOptions = {},
  ): Promise<AfterConversationLockOperation | undefined> {
    if (message.source === "business") {
      return this.handleBusinessMessageUnderPolicy(message, options);
    }
    return this.handleMessageUnderConversationLock(message, options);
  }

  private runAfterConversationLockInBackground(
    operation: AfterConversationLockOperation,
    updateId: number,
  ): void {
    void operation.run().catch((error) => {
      this.logger?.warn("Telegram assistant background operation failed.", redactSecrets({
        updateId,
        error: errorToMessage(error),
      }));
    });
  }

  private async nextQueuedMessage(
    conversationKey: string,
  ): Promise<TelegramQueuedMessage | undefined> {
    const queuedMessages = await this.store.listQueuedMessages(conversationKey);
    return queuedMessages.sort(compareQueuedMessagesOldestFirst)[0];
  }

  private async getQueuedMessageById(
    conversationKey: string,
    messageId: string,
  ): Promise<TelegramQueuedMessage | undefined> {
    const queuedMessages = await this.store.listQueuedMessages(conversationKey);
    return queuedMessages.find((message) => message.id === messageId);
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

    const cancelledQueued = await this.store.cancelQueuedMessages(message.conversationKey, {
      cancelledAt: now,
    });
    if (cancelledQueued.length > 0) {
      this.incrementMetric("telegram_queued_messages_total", { outcome: "cancelled" }, cancelledQueued.length);
    }
    await this.updatePendingActionGauges();
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
    await this.updatePendingActionGauges();
    await this.subscribeConversationToTask(message, task);
    const createdMessage =
      task.status === "ready" || task.status === "claimed"
        ? `Задача создана и поставлена в очередь: ${task.id}`
        : `Задача создана для triage: ${task.id}`;
    await this.sendPlainMessage(message, createdMessage);
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
    await this.updatePendingActionGauges();
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
      await this.ensureTelegramAttachmentsRegistered(existing, payload);
      return this.ensureExecutableTaskReady(existing, payload);
    }

    try {
      const executableDraft = isTelegramExecutableTaskDraft(payload.draft)
        ? payload.draft
        : undefined;
      const task = await this.taskTracker.createTask({
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
        ...(executableDraft?.repoPathKey
          ? { repoPathKey: executableDraft.repoPathKey }
          : {}),
        ...(executableDraft?.baseBranch
          ? { baseBranch: executableDraft.baseBranch }
          : {}),
        ...(executableDraft?.queue ? { queue: executableDraft.queue } : {}),
        tags: payload.draft.tags,
        acceptanceCriteria: payload.draft.acceptanceCriteria,
        ...(executableDraft
          ? { riskFactors: executableDraft.risk.reasons }
          : {}),
        externalRefs: [
          { provider: "telegram", externalKey: payload.externalKey },
        ],
        externalSnapshot: {
          chatId: payload.chatId,
          messageId: payload.messageId,
          userId: payload.userId,
          ...(payload.executionMode ? { executionMode: payload.executionMode } : {}),
          ...(executableDraft
            ? { risk: executableDraft.risk }
            : {}),
          ...(payload.attachments && payload.attachments.length > 0
            ? { attachments: payload.attachments }
            : {}),
        },
      });
      await this.ensureTelegramAttachmentsRegistered(task, payload);
      return this.ensureExecutableTaskReady(task, payload);
    } catch (error) {
      if (error instanceof DuplicateExternalRefError) {
        const existingAfterRace = await this.taskTracker.findTaskByExternalRef(
          "telegram",
          payload.externalKey,
        );
        if (existingAfterRace) {
          await this.ensureTelegramAttachmentsRegistered(existingAfterRace, payload);
          return this.ensureExecutableTaskReady(existingAfterRace, payload);
        }
      }
      throw error;
    }
  }

  private async ensureExecutableTaskReady(
    task: TaskRecord,
    payload: TaskDraftPayload,
  ): Promise<TaskRecord> {
    if (!this.taskTracker) {
      throw new Error("Task tracker is required to mark telegram tasks ready.");
    }
    if (
      payload.executionMode === "auto_ready" &&
      (task.status === "new" || task.status === "triage")
    ) {
      await this.taskTracker.markReady(
        task.id,
        "Telegram task approved for execution.",
      );
      return this.taskTracker.getTask(task.id);
    }

    return task;
  }

  private async ensureTelegramAttachmentsRegistered(
    task: TaskRecord,
    payload: TaskDraftPayload,
  ): Promise<void> {
    if (!payload.attachments || payload.attachments.length === 0) {
      return;
    }
    if (!this.taskTracker) {
      throw new Error("Task tracker is required to register telegram attachments.");
    }

    const registrationKey = buildTelegramAttachmentsRegistrationKey(payload.externalKey);
    if (task.events.some((event) => (
      event.kind === "attachments_registered" &&
      event.payload?.registrationKey === registrationKey
    ))) {
      return;
    }

    await this.taskTracker.appendEventOnce(task.id, {
      kind: "attachments_registered",
      source: "external_source",
      message: "Telegram attachments registered.",
      payload: {
        provider: "telegram",
        externalKey: payload.externalKey,
        registrationKey,
        source: {
          provider: "telegram",
          externalKey: payload.externalKey,
          kind: "attachments_registered",
        },
        attachments: payload.attachments,
      },
    });
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
    await this.sendMessage({
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
    await this.answerCallbackQuery({
      callbackQueryId,
      ...(text !== undefined ? { text } : {}),
    });
  }

  private async answerCallbackQuery(input: TelegramAnswerCallbackQueryInput): Promise<void> {
    try {
      await this.telegram.answerCallbackQuery(input);
    } catch (error) {
      if (error instanceof TelegramRetryAfterError) {
        this.incrementMetric("telegram_rate_limited_total", { direction: "outbound" });
        await waitForTelegramRetryAfter(error.retryAfterSeconds);
      }
      throw error;
    }
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

      await this.sendMessage({
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

  private encryptDigitalTwinAuditText(value: string | undefined): string | undefined {
    if (
      !value ||
      this.config.digitalTwin.fullTextRetentionDays <= 0 ||
      !this.config.digitalTwin.auditEncryptionKeyEnv
    ) {
      return undefined;
    }

    const keyId = this.config.digitalTwin.auditEncryptionKeyEnv;
    const key = process.env[keyId];
    if (!key) {
      throw new Error(`Telegram audit encryption key env var is missing: ${keyId}`);
    }

    return encryptTelegramAuditText(value, { key, keyId });
  }

  private async sendMessage(
    input: TelegramSendMessageInput,
  ): Promise<TelegramMessage> {
    try {
      const sent = await this.telegram.sendMessage(input);
      this.incrementMetric("telegram_messages_sent_total", { outcome: "success" });
      return sent;
    } catch (error) {
      this.incrementMetric("telegram_messages_sent_total", { outcome: "failure" });
      if (error instanceof TelegramRetryAfterError) {
        this.incrementMetric("telegram_rate_limited_total", { direction: "outbound" });
        await waitForTelegramRetryAfter(error.retryAfterSeconds);
      }
      throw error;
    }
  }

  private async enqueueMessage(
    message: TelegramInboundMessage,
  ): Promise<TelegramQueuedMessage> {
    const queued = await this.store.enqueueMessage(this.buildQueuedMessage(message));
    this.incrementMetric("telegram_queued_messages_total", { outcome: "queued" });
    return queued;
  }

  private isMessageStale(message: TelegramInboundMessage): boolean {
    const maxAgeSeconds = this.maxMessageAgeSecondsFor(message);
    if (maxAgeSeconds <= 0) {
      return false;
    }

    const receivedAtMs = Date.parse(message.receivedAt);
    if (!Number.isFinite(receivedAtMs)) {
      return false;
    }

    return Date.now() - receivedAtMs > maxAgeSeconds * 1000;
  }

  private maxMessageAgeSecondsFor(message: TelegramInboundMessage): number {
    const configuredMaxAgeSeconds = message.source === "business"
      ? this.config.profileAutomation.maxMessageAgeSeconds
      : this.config.maxInboundMessageAgeSeconds;
    return Math.max(0, Math.floor(configuredMaxAgeSeconds));
  }

  private logStaleMessageSkipped(
    message: TelegramInboundMessage,
    extra: { queuedMessageId?: string } = {},
  ): void {
    const receivedAtMs = Date.parse(message.receivedAt);
    const ageSeconds = Number.isFinite(receivedAtMs)
      ? Math.max(0, Math.floor((Date.now() - receivedAtMs) / 1000))
      : undefined;
    this.logger?.info("Telegram stale message skipped.", {
      updateId: message.updateId,
      conversationKey: message.conversationKey,
      source: message.source,
      maxAgeSeconds: this.maxMessageAgeSecondsFor(message),
      ...(ageSeconds !== undefined ? { ageSeconds } : {}),
      ...extra,
    });
  }

  private buildQueuedMessage(message: TelegramInboundMessage): TelegramQueuedMessage {
    const createdAt = new Date().toISOString();
    return {
      id: `queued:${message.updateId}`,
      conversationKey: message.conversationKey,
      chatId: message.chatId,
      ...(message.userId !== undefined ? { userId: message.userId } : {}),
      message: toPersistableInboundMessage(message),
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

  private async isTaskCreationRateLimited(userId: number): Promise<boolean> {
    const limit = this.config.userTaskCreationDailyLimit;
    if (limit <= 0) {
      return true;
    }
    const count = await this.store.countTaskCreationActionsForUser({
      userId,
      since: startOfUtcDayIso(new Date()),
    });
    return count >= limit;
  }

  private async isCodexQaRateLimited(userId: number): Promise<boolean> {
    const limit = this.config.userCodexQaDailyLimit;
    if (limit <= 0) {
      return true;
    }
    const count = await this.store.countAssistantTurnsForUser({
      userId,
      since: startOfUtcDayIso(new Date()),
    });
    return count >= limit;
  }

  private async updatePendingActionGauges(): Promise<void> {
    if (!this.observability) {
      return;
    }
    const actions = await this.store.listPendingActions();
    const states: TelegramPendingAction["status"][] = [
      "pending",
      "executing",
      "completed",
      "cancelled",
      "expired",
    ];
    for (const state of states) {
      const count = actions.filter((action) => action.status === state).length;
      this.observability.setGauge(
        "telegram_pending_actions_total",
        { state },
        count,
      );
    }
  }

  private intentNameForUpdate(update: TelegramUpdate): string {
    if (update.callback_query) {
      const parsed = parseCallbackData(update.callback_query.data);
      if (!parsed) {
        return "callback";
      }
      if (parsed.kind === "cancel") {
        return "reject_action";
      }
      if (parsed.kind === "select_task") {
        return "task_status";
      }
      return parsed.actionKind === "answer_question"
        ? "answer_ai_question"
        : "approve_action";
    }

    const message = normalizeTelegramUpdate(update, this.config);
    if (!message) {
      return "unknown";
    }
    return routeTelegramIntent(message.text, {
      projectQaEnabled: this.isProjectQaEnabledForMessage(message),
    }).name;
  }

  private incrementMetric(
    name: string,
    labels: Record<string, string> = {},
    value?: number,
  ): void {
    this.observability?.incrementCounter(name, labels, value);
  }
}

const startOfUtcDayIso = (date: Date): string =>
  new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  )).toISOString();

const waitForTelegramRetryAfter = async (retryAfterSeconds: number): Promise<void> => {
  const milliseconds = Math.min(Math.max(0, retryAfterSeconds), 60) * 1000;
  if (milliseconds <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

const toPersistableInboundMessage = (
  message: TelegramInboundMessage,
): TelegramInboundMessage => {
  const redactedText = message.redactedText ?? (
    message.text !== undefined ? redactSecrets(message.text) : undefined
  );

  return {
    id: message.id,
    updateId: message.updateId,
    conversationKey: message.conversationKey,
    source: message.source,
    chatId: message.chatId,
    ...(message.userId !== undefined ? { userId: message.userId } : {}),
    ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
    ...(redactedText !== undefined ? { text: redactedText, redactedText } : {}),
    ...(message.actor ? { actor: message.actor } : {}),
    ...(message.businessConnectionId
      ? { businessConnectionId: message.businessConnectionId }
      : {}),
    ...(message.isReplyToBot !== undefined
      ? { isReplyToBot: message.isReplyToBot }
      : {}),
    ...(message.replyToBotUsername
      ? { replyToBotUsername: message.replyToBotUsername }
      : {}),
    receivedAt: message.receivedAt,
  };
};

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

const buildAssistantTurnId = (message: TelegramInboundMessage): string => {
  const messagePart = message.messageId !== undefined
    ? message.messageId.toString(36)
    : "no-message";
  return `assistant-turn:${message.updateId.toString(36)}:${messagePart}`;
};

const buildDigitalTwinInboundMessageKey = (
  message: TelegramInboundMessage,
): string =>
  `telegram-business:${message.businessConnectionId}:${message.chatId}:${message.messageId}`;

const buildDigitalTwinOutboundMessageKey = (
  message: TelegramInboundMessage,
): string =>
  `telegram-business-reply:${message.businessConnectionId}:${message.chatId}:${message.messageId}`;

const buildDigitalTwinTurnId = (message: TelegramInboundMessage): string =>
  `tgdt_${message.updateId.toString(36)}_${(message.messageId ?? 0).toString(36)}`;

const buildDigitalTwinInboundMessageId = (
  message: TelegramInboundMessage,
): string =>
  `dtm_in_${message.updateId.toString(36)}_${(message.messageId ?? 0).toString(36)}`;

const buildDigitalTwinOutboundMessageId = (
  message: TelegramInboundMessage,
): string =>
  `dtm_out_${message.updateId.toString(36)}_${(message.messageId ?? 0).toString(36)}`;

const isWithinRoot = (root: string, candidate: string): boolean => {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  return (
    relativePath === "" ||
    (relativePath !== "" &&
      !relativePath.startsWith("..") &&
      !isAbsolute(relativePath))
  );
};

const realPathWithinRoot = async (
  root: string,
  candidate: string,
): Promise<{ root: string; candidate: string } | undefined> => {
  try {
    const realRoot = await realpath(root);
    const realCandidate = await realpath(candidate);
    if (!isWithinRoot(realRoot, realCandidate)) {
      return undefined;
    }
    return { root: realRoot, candidate: realCandidate };
  } catch {
    return undefined;
  }
};

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

const selectRelevantTasks = (
  question: string,
  tasks: TaskRecord[],
): TaskRecord[] => {
  const terms = extractSearchTerms(question);
  const scored = tasks.map((task) => ({
    task,
    score: scoreTaskForTerms(task, terms),
  }));
  const matching = scored
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score || compareTasksNewestFirst(left.task, right.task),
    );
  const selected = matching.length > 0
    ? matching.map((candidate) => candidate.task)
    : [...tasks].sort(compareTasksNewestFirst);

  return selected.slice(0, MAX_TASK_SOURCE_COUNT);
};

const extractSearchTerms = (question: string): string[] =>
  question
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .slice(0, 12);

const scoreTaskForTerms = (task: TaskRecord, terms: string[]): number => {
  if (terms.length === 0) {
    return 0;
  }
  const haystack = [
    task.id,
    task.title,
    task.description,
    task.repositoryName,
    ...task.tags,
    ...task.components,
  ].join(" ").toLowerCase();
  return terms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0,
  );
};

const compareTasksNewestFirst = (left: TaskRecord, right: TaskRecord): number =>
  right.updatedAt.localeCompare(left.updatedAt) ||
  right.createdAt.localeCompare(left.createdAt) ||
  right.id.localeCompare(left.id);

const formatTaskSourceLine = (task: TaskRecord): string => {
  const description = task.description.trim();
  return [
    `- ${task.id}: ${task.title}`,
    `status=${task.status}`,
    `repository=${task.repositoryName}`,
    `updatedAt=${task.updatedAt}`,
    description ? `description=${truncateSourceLine(description)}` : undefined,
  ].filter(Boolean).join("; ");
};

const sanitizeProjectSource = (
  source: AssistantSource,
): AssistantSource | undefined => {
  const body = redactSecrets(source.body, MAX_PROJECT_SOURCE_FILE_CHARS).trim();
  if (!body) {
    return undefined;
  }
  return {
    id: redactSecrets(source.id, 512),
    body,
  };
};

const truncateSourceLine = (value: string, maxLength = 500): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;

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

const buildExecutableTaskDraftResponse = (
  draft: TelegramExecutableTaskDraft,
  actionId: string,
): TelegramResponse => ({
  blocks: [
    { kind: "title", text: "Создать и запустить задачу?" },
    { kind: "field", label: "Название", value: draft.title },
    ...(draft.repositoryName || draft.queue
      ? [{
          kind: "field" as const,
          label: "Репозиторий/очередь",
          value: [draft.repositoryName, draft.queue].filter(Boolean).join(" / "),
        }]
      : []),
    {
      kind: "field",
      label: "Риск",
      value: `${draft.risk.riskLevel}: ${draft.risk.reasons.join(", ")}`,
    },
    {
      kind: "paragraph",
      text: draft.executionMode === "auto_ready"
        ? "После подтверждения задача будет поставлена в очередь выполнения."
        : "После подтверждения задача останется на triage/owner approval.",
    },
    {
      kind: "field",
      label: "Критерии",
      value: draft.acceptanceCriteria.join("\n"),
    },
  ],
  inlineButtonRows: [
    [
      { text: "Создать и запустить", callbackData: `c:${actionId}` },
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
  draft: TelegramTaskDraft | TelegramExecutableTaskDraft;
  sessionId?: string;
  executionMode?: TelegramExecutableTaskDraftExecutionMode;
  chatId: number;
  messageId: number;
  userId: number;
  externalKey: string;
  attachments?: TelegramAttachmentMetadata[];
}

const createExecutableTaskPendingActionFromSession = (
  message: TelegramInboundMessage,
  intent: TelegramIntent,
  session: TelegramExecutableTaskDraftSession,
): TelegramPendingAction => {
  if (message.messageId === undefined || message.userId === undefined) {
    throw new Error(
      "Cannot create executable telegram task pending action without message id and user id.",
    );
  }

  const actionId = buildPendingActionId(message.updateId, message.messageId);
  const externalKey = buildTelegramExternalKey(message.chatId, message.messageId);
  return {
    id: actionId,
    conversationKey: message.conversationKey,
    chatId: message.chatId,
    userId: message.userId,
    intent,
    payload: {
      draft: session.draft,
      sessionId: session.id,
      executionMode: session.draft.executionMode,
      chatId: message.chatId,
      messageId: message.messageId,
      userId: message.userId,
      externalKey,
      ...(message.attachments && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
    },
    status: "pending",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
  };
};

const buildTelegramAttachmentsRegistrationKey = (externalKey: string): string =>
  `telegram:${externalKey}:attachments_registered`;

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
  const attachments = payload.attachments;
  const executionMode = payload.executionMode;
  const sessionId = payload.sessionId;
  if (
    !isTelegramTaskDraft(draft) ||
    (
      executionMode !== undefined &&
      (
        !isTelegramExecutableTaskDraft(draft) ||
        !isTelegramExecutableTaskDraftExecutionMode(executionMode)
      )
    ) ||
    (sessionId !== undefined && typeof sessionId !== "string") ||
    typeof payload.chatId !== "number" ||
    typeof payload.messageId !== "number" ||
    typeof payload.userId !== "number" ||
    typeof payload.externalKey !== "string" ||
    (
      attachments !== undefined &&
      (!Array.isArray(attachments) || !attachments.every(isTelegramAttachmentMetadata))
    )
  ) {
    throw new Error("Invalid telegram task draft payload.");
  }

  return {
    draft,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(executionMode !== undefined ? { executionMode } : {}),
    chatId: payload.chatId,
    messageId: payload.messageId,
    userId: payload.userId,
    externalKey: payload.externalKey,
    ...(attachments !== undefined
      ? { attachments }
      : {}),
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

const isTelegramExecutableTaskDraft = (
  value: unknown,
): value is TelegramExecutableTaskDraft => {
  if (!isTelegramTaskDraft(value)) {
    return false;
  }
  const draft = value as Partial<TelegramExecutableTaskDraft>;
  return (
    (draft.repoPathKey === undefined || typeof draft.repoPathKey === "string") &&
    (draft.baseBranch === undefined || typeof draft.baseBranch === "string") &&
    (draft.queue === undefined || typeof draft.queue === "string") &&
    isTelegramTaskRiskAssessment(draft.risk) &&
    isTelegramExecutableTaskDraftExecutionMode(draft.executionMode)
  );
};

const isTelegramTaskRiskAssessment = (
  value: unknown,
): value is TelegramExecutableTaskDraft["risk"] => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const risk = value as Partial<TelegramExecutableTaskDraft["risk"]>;
  return (
    (
      risk.riskLevel === "low" ||
      risk.riskLevel === "medium" ||
      risk.riskLevel === "high"
    ) &&
    Array.isArray(risk.reasons) &&
    risk.reasons.every((reason) => typeof reason === "string") &&
    typeof risk.requiresOwnerApproval === "boolean"
  );
};

const isTelegramExecutableTaskDraftExecutionMode = (
  value: unknown,
): value is TelegramExecutableTaskDraftExecutionMode =>
  value === "auto_ready" ||
  value === "owner_approval" ||
  value === "triage_only";

const isTelegramAttachmentMetadata = (
  value: unknown,
): value is TelegramAttachmentMetadata => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const attachment = value as Partial<TelegramAttachmentMetadata>;
  return (
    (attachment.type === "document" || attachment.type === "photo") &&
    typeof attachment.fileId === "string" &&
    (attachment.fileName === undefined || typeof attachment.fileName === "string") &&
    (attachment.mimeType === undefined || typeof attachment.mimeType === "string") &&
    (attachment.size === undefined || typeof attachment.size === "number") &&
    (attachment.width === undefined || typeof attachment.width === "number") &&
    (attachment.height === undefined || typeof attachment.height === "number")
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

const isOwnerRoutedBusinessTaskDraftAction = (
  action: TelegramPendingAction,
): boolean =>
  action.intent.name === "create_task_draft" &&
  typeof action.payload.chatId === "number" &&
  typeof action.payload.userId === "number" &&
  (
    action.payload.chatId !== action.chatId ||
    action.payload.userId !== action.userId
  );

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

const compareQueuedMessagesOldestFirst = (
  left: TelegramQueuedMessage,
  right: TelegramQueuedMessage,
): number =>
  left.createdAt.localeCompare(right.createdAt) ||
  left.id.localeCompare(right.id);

const isPendingActionUnexpired = (
  action: TelegramPendingAction,
  now: string,
): boolean => Date.parse(action.expiresAt) > Date.parse(now);

const buildPendingActionId = (updateId: number, messageId: number): string =>
  `tgpa_${updateId.toString(36)}_${messageId.toString(36)}`;

const buildExecutableDraftSessionId = (updateId: number, messageId: number): string =>
  `tged_${updateId.toString(36)}_${messageId.toString(36)}`;

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
      text: update.business_message.text ?? update.business_message.caption,
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
      text: update.edited_business_message.text ?? update.edited_business_message.caption,
      redactedTextPrefix: "[edited] ",
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
      text: update.message.text ?? update.message.caption,
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
  redactedTextPrefix?: string;
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
  const redactedText = text !== undefined
    ? `${input.redactedTextPrefix ?? ""}${redactSecrets(text)}`
    : undefined;
  const replyUsername = replyToBotUsername(input.message);
  const attachments = extractTelegramAttachments(input.message, input.config);
  const message: TelegramInboundMessage = {
    id: `telegram:${input.update.update_id}:${input.idSuffix}`,
    updateId: input.update.update_id,
    conversationKey,
    source,
    chatId: input.message.chat.id,
    ...(input.user?.id !== undefined ? { userId: input.user.id } : {}),
    ...(input.user?.is_bot !== undefined ? { senderIsBot: input.user.is_bot } : {}),
    messageId: input.message.message_id,
    ...(text !== undefined ? { text, redactedText } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(input.user ? { actor: actorForUser(input.user, input.config) } : {}),
    ...(businessConnectionId ? { businessConnectionId } : {}),
    ...(replyUsername ? { replyToBotUsername: replyUsername, isReplyToBot: true } : {}),
    receivedAt: new Date(input.message.date * 1000).toISOString(),
  };

  return { message };
};

const extractTelegramAttachments = (
  message: NonNullable<TelegramUpdate["message"]>,
  config: TelegramAssistantConfig,
): TelegramAttachmentMetadata[] => {
  const candidates: TelegramAttachmentMetadata[] = [];
  if (message.document) {
    candidates.push(sanitizeTelegramAttachment({
      type: "document",
      fileId: message.document.file_id,
      ...(message.document.file_name
        ? { fileName: message.document.file_name }
        : {}),
      ...(message.document.mime_type
        ? { mimeType: message.document.mime_type }
        : {}),
      ...(message.document.file_size !== undefined
        ? { size: message.document.file_size }
        : {}),
    }));
  }

  const photo = selectLargestTelegramPhoto(message.photo);
  if (photo) {
    candidates.push(sanitizeTelegramAttachment({
      type: "photo",
      fileId: photo.file_id,
      mimeType: "image/jpeg",
      ...(photo.file_size !== undefined ? { size: photo.file_size } : {}),
      width: photo.width,
      height: photo.height,
    }));
  }

  return candidates.filter((candidate) =>
    validateTelegramAttachment(candidate, config.media).accepted,
  );
};

const selectLargestTelegramPhoto = (
  photos: NonNullable<TelegramUpdate["message"]>["photo"],
): TelegramPhotoSize | undefined => {
  if (!photos || photos.length === 0) {
    return undefined;
  }

  return [...photos].sort((left, right) =>
    (right.file_size ?? 0) - (left.file_size ?? 0) ||
    (right.width * right.height) - (left.width * left.height),
  )[0];
};

const sanitizeTelegramAttachment = (
  attachment: TelegramAttachmentMetadata,
): TelegramAttachmentMetadata => ({
  type: attachment.type,
  fileId: truncateMetadata(attachment.fileId, 256),
  ...(attachment.fileName
    ? { fileName: truncateMetadata(attachment.fileName, 256) }
    : {}),
  ...(attachment.mimeType
    ? { mimeType: truncateMetadata(attachment.mimeType, 128) }
    : {}),
  ...(attachment.size !== undefined ? { size: attachment.size } : {}),
  ...(attachment.width !== undefined ? { width: attachment.width } : {}),
  ...(attachment.height !== undefined ? { height: attachment.height } : {}),
});

const truncateMetadata = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : value.slice(0, maxLength);

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
