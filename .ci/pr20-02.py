from pathlib import Path
r=Path.cwd()
(r/'src/domain/taskTracker/clarification.ts').write_text('''import type { TaskComment } from "./types.js";

/** Equal timestamps have no ordering guarantee after a PostgreSQL round trip. */
export const latestUnambiguousQuestion = (comments: readonly TaskComment[]): TaskComment | undefined => {
  const questions = comments.filter((comment) => comment.kind === "question")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = questions[0];
  if (!latest || questions[1]?.createdAt === latest.createdAt) return undefined;
  return latest;
};

export const answerToQuestion = (
  comments: readonly TaskComment[], question: TaskComment,
): TaskComment | undefined => comments.filter((comment) => {
  if (comment.kind !== "answer") return false;
  const linkedId = (comment.payload as Record<string, unknown> | undefined)?.questionId;
  // An explicit link is stronger evidence than timestamp ordering. Never reuse an
  // answer to a different question merely because it arrived later.
  return typeof linkedId === "string"
    ? linkedId === question.id && comment.createdAt >= question.createdAt
    : comment.createdAt > question.createdAt;
}).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
''')
for name in ['src/domain/taskTracker/inMemoryTaskTracker.ts','src/integrations/internalTracker/postgresTaskTracker.ts']:
 f=r/name;s=f.read_text();imp='./clarification.js' if 'inMemory' in name else '../../domain/taskTracker/clarification.js'
 s='import { latestUnambiguousQuestion } from "'+imp+'";\n'+s
 anchor='  async recordHumanAnswer(taskId: string, input: HumanAnswerInput): Promise<void> {'
 start=s.index(anchor);end=s.index('\n  async recordAgentRun(',start);section=s[start:end]
 if 'inMemory' in name:
  section=section.replace('    const createdAt = this.nowIso();','    const questionId = input.questionId ?? latestUnambiguousQuestion(task.comments)?.id;\n    const createdAt = this.nowIso();',1)
 else:
  section=section.replace(anchor,anchor+'\n    const current = await this.getTask(taskId);\n    const questionId = input.questionId ?? latestUnambiguousQuestion(current.comments)?.id;')
 idx=section.index('    const questionId =');lineend=section.index('\n',idx)
 section=section[:lineend]+section[lineend:].replace('input.questionId','questionId')
 f.write_text(s[:start]+section+s[end:])
p=r/'src/domain/internalWorkerOrchestrator.ts';s=p.read_text()
s='import { answerToQuestion, latestUnambiguousQuestion } from "./taskTracker/clarification.js";\n'+s
old='''    const latestQuestion = comments
      .filter((comment) => comment.kind === "question")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);''';assert s.count(old)==1;s=s.replace(old,'    const latestQuestion = latestUnambiguousQuestion(comments);')
old='''    const answer = comments
      .filter((comment) => comment.kind === "answer" && comment.createdAt > latestQuestion.createdAt)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);''';assert s.count(old)==1;s=s.replace(old,'    const answer = answerToQuestion(comments, latestQuestion);')
s=s.replace('export class InternalWorkerOrchestrator {','''class ExecutionLeaseUnavailableError extends Error {}

export class InternalWorkerOrchestrator {
  private readonly executionClaims = new Map<string, ClaimedTask>();

  private async assertExecutionLease(taskId: string): Promise<void> {
    const claim = this.executionClaims.get(taskId);
    if (!claim) throw new ExecutionLeaseUnavailableError("No execution claim available.");
    try {
      const active = await this.taskTracker.listActiveLeases();
      for (const expected of [claim.taskLease, claim.repositoryLease]) {
        if (!active.some((lease) => lease.leaseId === expected.leaseId &&
          lease.workerId === expected.workerId && lease.token === expected.token)) {
          throw new ExecutionLeaseUnavailableError("Execution lease lost; operator recovery is required.");
        }
      }
    } catch (error) {
      if (error instanceof ExecutionLeaseUnavailableError) throw error;
      throw new ExecutionLeaseUnavailableError("Cannot confirm execution ownership; publication is blocked.");
    }
  }
''',1)
old='''    try {
      return await run();
    } finally {
      clearInterval(interval);'''
new='''    this.executionClaims.set(claim.task.id, claim);
    try {
      return await run();
    } finally {
      this.executionClaims.delete(claim.task.id);
      clearInterval(interval);''';assert s.count(old)==1;s=s.replace(old,new)
old='''      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof TemporaryIntegrationError || isDirtyRepositorySwitchError(error)) {'''
new='''      } catch (error) {
        if (error instanceof ExecutionLeaseUnavailableError) {
          this.logger.warn(error.message, { taskId: claim.task.id });
          return false;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof TemporaryIntegrationError || isDirtyRepositorySwitchError(error)) {''';assert s.count(old)==1;s=s.replace(old,new)
old='''    } catch (error) {
      if (error instanceof TemporaryIntegrationError) {
        this.logger.error("Temporary integration error while processing internal task.", {'''
new='''    } catch (error) {
      if (error instanceof ExecutionLeaseUnavailableError) {
        this.logger.warn(error.message, { taskId: claim.task.id });
        return "waiting";
      }
      if (error instanceof TemporaryIntegrationError) {
        this.logger.error("Temporary integration error while processing internal task.", {''';assert s.count(old)==1;s=s.replace(old,new)
s=s.replace('    await this.taskTracker.setStatus(task.id, "analyzing", "Internal task analysis started.");','    await this.assertExecutionLease(task.id);\n    await this.taskTracker.setStatus(task.id, "analyzing", "Internal task analysis started.");')
s=s.replace('    const branch = await context.git.checkoutTaskBranch(task.id);','    await this.assertExecutionLease(task.id);\n    const branch = await context.git.checkoutTaskBranch(task.id);')
s=s.replace('''    const execution = await run(observer);
    await observerFlush;''','''    await this.assertExecutionLease(taskId);
    const execution = await run(observer);
    await this.assertExecutionLease(taskId);
    await observerFlush;''')
s=s.replace('    const gates = await runQualityGates(context.config, {','    await this.assertExecutionLease(taskId);\n    const gates = await runQualityGates(context.config, {')
s=s.replace('''    const validation: ValidationResult = {
      changed: true,''','''    await this.assertExecutionLease(taskId);
    const validation: ValidationResult = {
      changed: true,''')
start=s.index('  private async publish(');end=s.index('  private async runCodexStage',start);a=s[start:end]
a=a.replace('    await this.recordWorkflowEvent(', '    await this.assertExecutionLease(taskId);\n    await this.recordWorkflowEvent(',1)
a=a.replace('      await context.git.commit(', '      await this.assertExecutionLease(taskId);\n      await context.git.commit(')
a=a.replace('    await context.git.push(branch);','    await this.assertExecutionLease(taskId);\n    await context.git.push(branch);')
a=a.replace('      mergeRequest = await context.gitlab.createMergeRequest(', '      await this.assertExecutionLease(taskId);\n      mergeRequest = await context.gitlab.createMergeRequest(')
a=a.replace('    await this.workflow.recordMergeRequest(', '    await this.assertExecutionLease(taskId);\n    await this.workflow.recordMergeRequest(')
s=s[:start]+a+s[end:]
start=s.index('  private async handleInternalReviewFeedback(');end=s.index('  private async prepareImageContext(',start);a=s[start:end]
a=a.replace('      const checkedOutBranch = await context.git.checkoutBranch(branch);','      await this.assertExecutionLease(task.id);\n      const checkedOutBranch = await context.git.checkoutBranch(branch);')
a=a.replace('        await context.git.commit(', '        await this.assertExecutionLease(task.id);\n        await context.git.commit(')
a=a.replace('      await context.git.push(checkedOutBranch);','      await this.assertExecutionLease(task.id);\n      await context.git.push(checkedOutBranch);')
a=a.replace('        await context.gitlab.replyToDiscussion(', '        await this.assertExecutionLease(task.id);\n        await context.gitlab.replyToDiscussion(')
a=a.replace('      await this.workflow.recordReviewMetadata(', '      await this.assertExecutionLease(task.id);\n      await this.workflow.recordReviewMetadata(')
s=s[:start]+a+s[end:];p.write_text(s)
