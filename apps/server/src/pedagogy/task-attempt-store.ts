import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db, DbTx } from "../db/client.js";
import { taskAttempts } from "../db/schema.js";
import { readPublishedCard } from "../prep/publication.js";
import type { TaskAttempt } from "./evidence.js";

/** Sole owner of server-recorded task delivery; never accepts model-provided assistance. */
export function recordTaskAttempt(tx: DbTx, input: Omit<TaskAttempt, "answer"> & { sessionId: string }): boolean {
  const card = readPublishedCard(tx, input.cardVersion);
  if (!card || !card.tasks.some((task) => task.id === input.taskId)) return false;
  tx.insert(taskAttempts).values({ id: randomUUID(), sessionId: input.sessionId, cardVersion: input.cardVersion,
    taskId: input.taskId, userMessageId: input.userMessageId, assistance: input.assistance,
    observedPerformance: input.observedPerformance, createdAt: new Date() }).onConflictDoNothing().run();
  return true;
}
export function readTaskAttempts(db: Db, sessionId: string, answers: Map<string, string>): TaskAttempt[] {
  return db.select().from(taskAttempts).where(eq(taskAttempts.sessionId, sessionId)).all().map((row) => ({
    cardVersion: row.cardVersion, taskId: row.taskId, userMessageId: row.userMessageId,
    answer: answers.get(row.userMessageId) ?? "", assistance: row.assistance,
    observedPerformance: row.observedPerformance,
  }));
}
