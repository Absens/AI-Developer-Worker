from pathlib import Path
r=Path.cwd()
p=r/'tests/internalWorkerOrchestrator.test.ts';s=p.read_text()
s=s.replace('it("recovers stale fixing_review tasks without an active lease"','it("requires confirmed executor stop before recovering stale fixing_review work"')
old='''    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("processed");
    expect(updated.status).toBe("review");
    expect(gitlab.replies).toHaveLength(1);'''
assert s.count(old)==1
s=s.replace(old,'''    expect(await orchestrator.runOnce()).toBe("idle");
    expect((await tracker.getTask(task.id)).status).toBe("fixing_review");
    expect(codex.initialCalls).toBe(0);
    expect(git.pushes).toEqual([]);
    await tracker.recoverAbandonedTask(task.id, {
      actor: human, expectedStatus: "fixing_review", previousExecutorStopped: true,
      reason: "Operator confirmed old executor stopped.",
    });
    const outcome = await orchestrator.runOnce();
    const updated = await tracker.getTask(task.id);

    expect(outcome).toBe("processed");
    expect(updated.status).toBe("review");
    expect(gitlab.replies).toHaveLength(1);''')
s+='''
describe("InternalWorkerOrchestrator same-timestamp clarification recovery", () => {
  it.each([false, true])("uses the answered thread and falls back after failed resume (explicit question ID: %s)", async (explicitId) => {
    const tracker = new InMemoryTaskTrackerClient({ now: () => new Date("2026-11-10T00:00:00Z") });
    const task = await tracker.createTask(baseTaskInput({ id: "equal-time-answer" }));
    await tracker.setStatus(task.id, "claimed");
    await tracker.setStatus(task.id, "awaiting_human");
    await tracker.askClarification(task.id, {
      workerId: "worker-1", summary: "Need input", blockingReason: "Missing choice",
      question: "Continue?", options: [], resumeHint: "/resume", threadId: "original-thread",
    });
    const question = (await tracker.getTask(task.id)).comments.find((comment) => comment.kind === "question")!;
    await tracker.recordHumanAnswer(task.id, {
      author: human, body: "/resume", ...(explicitId ? { questionId: question.id } : {}),
    });
    const git = new FakeGitService();
    const codex = new FakeCodexRunner(git);
    const resume = vi.spyOn(codex, "runResume").mockResolvedValue({
      process: { exitCode: 1, stdout: "", stderr: "Thread unavailable" },
    });
    const fresh = vi.spyOn(codex, "runInitial").mockImplementation(async () => {
      git.hasUncommittedChanges = true;
      return { process: { exitCode: 0, stdout: "", stderr: "" }, finalMessage: "Implemented." };
    });
    const orchestrator = createOrchestrator(tracker, new FakeGitLabService(), codex, git);
    await orchestrator.runOnce();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.[0]).toBe("original-thread");
    expect(fresh).toHaveBeenCalledTimes(1);
    expect((await tracker.getTask(task.id)).status).toBe("review");
  });
});
''';p.write_text(s)
p=r/'tests/reliableValidation.test.ts';s=p.read_text().replace('  return { directory, config, tracker, orchestrator, writes };','  return { directory, config, tracker, orchestrator, writes, git };')
s+='''
describe("lost execution ownership", () => {
  it("never publishes or marks failure after the validation step loses its lease", async () => {
    const f = await recoveredTask();
    const originalHasChanges = f.git.hasChanges;
    let calls = 0;
    f.git.hasChanges = async () => {
      calls += 1;
      if (calls === 2) {
        for (const lease of await f.tracker.listActiveLeases()) {
          await f.tracker.releaseLease(lease.leaseId, { workerId: lease.workerId, token: lease.token });
        }
      }
      return originalHasChanges.call(f.git);
    };
    expect(await f.orchestrator.runOnce()).toBe("waiting");
    const task = await f.tracker.getTask(taskId);
    expect(task.status).toBe("validating");
    expect(task.mergeRequests).toHaveLength(0);
    expect(f.writes).toEqual([]);
  });
});
''';p.write_text(s)
p=r/'tests/humanTaskApi.test.ts';s=p.read_text();s+='''
describe("abandoned execution recovery authorization", () => {
  it("requires operator role, explicit stopped confirmation and matching current state", async () => {
    const tracker = new InMemoryTaskTrackerClient();
    const task = await tracker.createTask(baseTaskInput({ id: "abandoned-api" }));
    await tracker.setStatus(task.id, "claimed");
    await tracker.setStatus(task.id, "analyzing");
    const { baseUrl } = await createServer(tracker);
    const command = `/api/tasks/${task.id}/commands/recover-abandoned`;
    const body = { expectedStatus: "analyzing", previousExecutorStopped: true, reason: "Operator verified process shutdown." };
    const request = (headers: Record<string, string>, value: object) => requestJson(baseUrl, command, {
      method: "POST", headers, body: JSON.stringify(value),
    });
    expect((await request(developerHeaders, body)).status).toBe(403);
    expect((await request(operatorHeaders, { ...body, previousExecutorStopped: false })).status).toBeGreaterThanOrEqual(400);
    expect((await request(operatorHeaders, { ...body, expectedStatus: "implementing" })).status).toBeGreaterThanOrEqual(400);
    for (const action of ["mark-ready", "resume", "hold", "cancel", "retry"]) {
      expect((await requestJson(baseUrl, `/api/tasks/${task.id}/commands/${action}`, {
        method: "POST", headers: operatorHeaders, body: JSON.stringify({ reason: "Cannot bypass recovery" }),
      })).status).toBe(409);
    }
    expect((await tracker.getTask(task.id)).status).toBe("analyzing");
    const recovered = await request(operatorHeaders, body);
    expect(recovered.status).toBe(200);
    expect((await tracker.getTask(task.id)).status).toBe("ready");
  });
});
''';p.write_text(s)
p=r/'tests/postgres/tracker.integration.ts';s=p.read_text()
s=s.replace('it("reclaims expired work and rejects stale credentials for the new leases"','it("recovers started work only after confirmed executor stop and rejects stale credentials"')
old='    const current = claimed(await b.claim("repo-a", "expiring", 60));';assert s.count(old)==1
s=s.replace(old,'''    // Expiration alone must not authorize two processes in the same checkout.
    await a.tracker.createTask(taskInput("same-checkout"));
    expect(await b.claim("repo-a", "expiring", 60)).toBeNull();
    expect(await b.claim("repo-a", "same-checkout", 60)).toBeNull();
    const recovery = {
      actor: human, expectedStatus: "analyzing" as const,
      previousExecutorStopped: true, reason: "Operator verified executor and child processes stopped.",
    };
    await expect(b.tracker.recoverAbandonedTask("expiring", { ...recovery, previousExecutorStopped: false })).rejects.toThrow();
    const recovered = await b.tracker.recoverAbandonedTask("expiring", recovery);
    expect(recovered.status).toBe("ready");
    expect(recovered.events.at(-1)?.payload).toMatchObject({ recovery: "operator_confirmed", previousExecutorStopped: true });
    const current = claimed(await b.claim("repo-a", "expiring", 60));''')
anchor='describe("real PostgreSQL lease lifecycle", () => {'
s=s.replace(anchor,anchor+'''
  it("automatically reclaims a claim that never entered an execution stage", async () => {
    const f = await start();
    const a = f.newWorker("before-start");
    const b = f.newWorker("replacement");
    await a.tracker.createTask(taskInput("not-started"));
    const old = claimed(await a.claim("repo-a", "not-started", 10));
    f.advance(11_000);
    const fresh = claimed(await b.claim("repo-a", "not-started", 60));
    expect(fresh.task.id).toBe(old.task.id);
    expect(leaseIds(fresh)).not.toEqual(leaseIds(old));
  });

  it("refuses operator recovery while valid leases exist and rolls back the attempted change", async () => {
    const f = await start();
    const a = f.newWorker("running");
    await a.tracker.createTask(taskInput("still-owned"));
    claimed(await a.claim("repo-a", "still-owned", 60));
    await a.tracker.setStatus("still-owned", "analyzing");
    await expect(a.tracker.recoverAbandonedTask("still-owned", {
      actor: human, expectedStatus: "analyzing", previousExecutorStopped: true, reason: "test",
    })).rejects.toThrow(/active leases/);
    expect((await a.tracker.getTask("still-owned")).status).toBe("analyzing");
  });
''')
s=s.replace(anchor,anchor+'''
  it("persists a question ID for a same-timestamp human answer across connections", async () => {
    const f = await start();
    const a = f.newWorker("question-worker");
    const b = f.newWorker("reader");
    await a.tracker.createTask(taskInput("answer-link"));
    await a.tracker.askClarification("answer-link", {
      workerId: a.workerId, threadId: "resume-thread", summary: "Need input", blockingReason: "Missing choice",
      question: "Continue?", options: [], resumeHint: "/resume",
    });
    await a.tracker.recordHumanAnswer("answer-link", { author: human, body: "/resume" });
    const task = await b.tracker.getTask("answer-link");
    const question = task.comments.find((comment) => comment.kind === "question")!;
    const answer = task.comments.find((comment) => comment.kind === "answer")!;
    expect(answer.createdAt).toBe(question.createdAt);
    expect(answer.payload).toMatchObject({ questionId: question.id });
  });

  it("serializes concurrent operator recoveries and accepts only one confirmation", async () => {
    const f = await start();
    const a = f.newWorker("operator-a");
    const b = f.newWorker("operator-b");
    await a.tracker.createTask(taskInput("recover-once"));
    claimed(await a.claim("repo-a", "recover-once", 10));
    await a.tracker.setStatus("recover-once", "analyzing");
    f.advance(11_000);
    const input = { actor: human, expectedStatus: "analyzing" as const, previousExecutorStopped: true, reason: "Verified shutdown." };
    const results = await Promise.allSettled([
      a.tracker.recoverAbandonedTask("recover-once", input),
      b.tracker.recoverAbandonedTask("recover-once", input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await a.tracker.getTask("recover-once")).status).toBe("ready");
  });
''');p.write_text(s)
