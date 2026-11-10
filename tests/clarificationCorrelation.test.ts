import { describe, expect, it } from "vitest";
import { answerToQuestion, latestUnambiguousQuestion } from "../src/domain/taskTracker/clarification.js";
import type { TaskComment } from "../src/domain/taskTracker/types.js";

const question: TaskComment = { id: "q1", taskId: "task", kind: "question", author: { owner: "worker_agent", id: "worker" }, body: "Which?", createdAt: "2026-11-10T00:00:00.000Z" };
const answer = (questionId?: string, createdAt = question.createdAt): TaskComment => ({
  ...question, id: "a1", kind: "answer", body: "/resume", author: { owner: "human", id: "user" }, createdAt,
  payload: questionId ? { questionId } : {},
});
describe("clarification correlation", () => {
  it("accepts an explicitly linked answer with the same timestamp", () => {
    expect(answerToQuestion([question, answer("q1")], question)?.id).toBe("a1");
  });
  it("does not reuse a later answer to a different question", () => {
    expect(answerToQuestion([question, answer("old-q", "2026-11-10T00:00:01.000Z")], question)).toBeUndefined();
  });
  it("does not infer chronology from lexicographical UUID ordering for equal timestamps", () => {
    expect(latestUnambiguousQuestion([question, { ...question, id: "q2" }])).toBeUndefined();
    expect(answerToQuestion([answer(), question], question)).toBeUndefined();
  });
  it("preserves later unlinked legacy answers", () => {
    expect(answerToQuestion([question, answer(undefined, "2026-11-10T00:00:01.000Z")], question)?.id).toBe("a1");
  });
});
