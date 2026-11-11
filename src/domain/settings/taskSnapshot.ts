import type { TaskRecord, TaskTrackerClient } from "../taskTracker/types.js";
import type { ManagedExecutionSnapshot } from "./runtime.js";
import { validateDefinition } from "./validation.js";

/** Pins non-secret configuration for the task, including resume/review after process restarts. */
export const pinManagedTaskConfiguration = async (
  tracker: TaskTrackerClient, task: TaskRecord, snapshot: ManagedExecutionSnapshot, workerId: string,
): Promise<ManagedExecutionSnapshot> => {
  const previous = task.events.find(event => event.kind === "managed_configuration_pinned" && event.source === "worker_agent");
  if (previous) {
    const payload = previous.payload;
    if (!payload || typeof payload.revision !== "number") throw new Error("Invalid stored managed task configuration.");
    const definition = validateDefinition(payload.definition);
    if (definition.connectionId !== snapshot.active.definition.connectionId || definition.gitlabProjectId !== snapshot.active.definition.gitlabProjectId) {
      throw new Error("Pinned task configuration belongs to a different repository.");
    }
    return { ...snapshot, active: { ...snapshot.active, revision: payload.revision, definition } };
  }
  await tracker.appendEvent(task.id, {
    kind: "managed_configuration_pinned", source: "worker_agent", actor: { owner: "worker_agent", id: workerId },
    message: `Managed project configuration v${snapshot.active.revision} pinned for this task.`,
    payload: { revision: snapshot.active.revision, definition: snapshot.active.definition },
  });
  return snapshot;
};
