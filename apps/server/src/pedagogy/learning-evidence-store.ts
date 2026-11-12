import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { LearningEvidence } from "@elenchi/shared";
import type { Db, DbTx } from "../db/client.js";
import { learningEvidence } from "../db/schema.js";

/** Sole owner of persisted evidence; callers must already bind a real message id. */
export function recordLearningEvidence(tx: DbTx, input: LearningEvidence & { sessionId: string }): void {
  tx.insert(learningEvidence).values({ id: randomUUID(), sessionId: input.sessionId, cardVersion: input.cardVersion,
    taskId: input.taskId, requirementId: input.requirementId, userMessageId: input.userMessageId,
    answerQuote: input.answerQuote, verdict: input.verdict, rationale: input.rationale,
    assessmentVersion: input.assessmentVersion, createdAt: new Date() }).onConflictDoNothing().run();
}
export function readLearningEvidence(db: Db, sessionId: string, cardVersion: string): LearningEvidence[] {
  return db.select().from(learningEvidence).where(eq(learningEvidence.sessionId, sessionId)).orderBy(desc(learningEvidence.createdAt), desc(learningEvidence.id)).all()
    .filter((row) => row.cardVersion === cardVersion).map((row) => ({ cardVersion: row.cardVersion, taskId: row.taskId,
      requirementId: row.requirementId, userMessageId: row.userMessageId, answerQuote: row.answerQuote,
      verdict: row.verdict, rationale: row.rationale, assessmentVersion: row.assessmentVersion }));
}
