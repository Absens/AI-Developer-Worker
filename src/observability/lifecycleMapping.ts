import type {
  TaskEvent as TrackerTaskEvent,
  TaskRecord,
} from "../domain/taskTracker/types.js";
import type {
  TaskEventInput as ObservabilityEventInput,
  TaskEventStatus,
  TaskEventType,
} from "./events.js";

export interface LifecycleMappingContext {
  workerId?: string;
  task?: Pick<TaskRecord, "id" | "repositoryName" | "status" | "updatedAt">;
}

export interface LifecycleEventMapping {
  taskEventKind: string;
  observabilityType: TaskEventType;
  status: TaskEventStatus;
  failureClassification?: string;
}

export const TASK_LIFECYCLE_EVENT_MAPPINGS: LifecycleEventMapping[] = [
  { taskEventKind: "task_claimed", observabilityType: "task_picked", status: "info" },
  { taskEventKind: "analysis_recorded", observabilityType: "analysis_completed", status: "info" },
  {
    taskEventKind: "clarification_requested",
    observabilityType: "clarification_requested",
    status: "warning",
  },
  {
    taskEventKind: "validation_recorded",
    observabilityType: "validation_completed",
    status: "info",
  },
  { taskEventKind: "merge_request_recorded", observabilityType: "mr_ready", status: "info" },
  {
    taskEventKind: "human_answer_recorded",
    observabilityType: "task_waiting",
    status: "info",
  },
  {
    taskEventKind: "task_proposal_created",
    observabilityType: "queue_polled",
    status: "info",
  },
  {
    taskEventKind: "task_proposal_auto_approved",
    observabilityType: "queue_polled",
    status: "info",
  },
  {
    taskEventKind: "task_proposal_rejected",
    observabilityType: "task_completed",
    status: "warning",
  },
  {
    taskEventKind: "external_status_synced",
    observabilityType: "worker_ready",
    status: "info",
  },
];

const mappingByKind = new Map(
  TASK_LIFECYCLE_EVENT_MAPPINGS.map((mapping) => [mapping.taskEventKind, mapping]),
);

const typeForStatusTransition = (
  payload: Record<string, unknown> | undefined,
): Pick<LifecycleEventMapping, "observabilityType" | "status"> | undefined => {
  const to = typeof payload?.to === "string" ? payload.to : undefined;
  if (to === "done") {
    return { observabilityType: "task_completed", status: "info" };
  }
  if (to === "failed") {
    return { observabilityType: "task_failed", status: "error" };
  }
  if (to === "awaiting_human" || to === "blocked" || to === "human_testing") {
    return {
      observabilityType: "task_waiting",
      status: to === "human_testing" ? "info" : "warning",
    };
  }
  if (to === "review") {
    return { observabilityType: "mr_ready", status: "info" };
  }
  return undefined;
};

export const mapTaskTimelineEventToObservability = (
  event: TrackerTaskEvent,
  context: LifecycleMappingContext = {},
): ObservabilityEventInput | undefined => {
  const statusTransition =
    event.kind === "task_status_changed"
      ? typeForStatusTransition(event.payload)
      : undefined;
  const staticMapping = mappingByKind.get(event.kind);
  const mapped = statusTransition ?? staticMapping;
  if (!mapped) {
    return undefined;
  }

  const workerId =
    event.actor?.id ??
    (typeof event.payload?.workerId === "string" ? event.payload.workerId : undefined) ??
    context.workerId ??
    "unknown";
  const failureClassification =
    typeof event.payload?.failureKind === "string"
      ? event.payload.failureKind
      : typeof event.payload?.failureClassification === "string"
        ? event.payload.failureClassification
        : undefined;

  return {
    id: event.id,
    timestamp: event.createdAt,
    workerId,
    ...(context.task?.repositoryName
      ? { repositoryName: context.task.repositoryName }
      : {}),
    issueKey: event.taskId,
    type: mapped.observabilityType,
    status:
      event.kind === "validation_recorded" && event.payload?.status === "failed"
        ? "error"
        : mapped.status,
    message: event.message ?? event.kind,
    details: {
      taskEventKind: event.kind,
      taskId: event.taskId,
      workerId,
      repositoryName: context.task?.repositoryName,
      leaseId:
        typeof event.payload?.taskLeaseId === "string"
          ? event.payload.taskLeaseId
          : undefined,
      repositoryLeaseId:
        typeof event.payload?.repositoryLeaseId === "string"
          ? event.payload.repositoryLeaseId
          : undefined,
      statusFrom: event.payload?.from,
      statusTo: event.payload?.to,
      failureClassification,
    },
  };
};
