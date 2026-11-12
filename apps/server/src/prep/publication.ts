import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { TeachingCardSchema, type TeachingCard } from "@elenchi/shared";
import type { Db } from "../db/client.js";
import { hasPassingCardReview } from "./review.js";
import { lessonCardVersions, lessons, materialChunks, materialProgress, prepTasks, sessions } from "../db/schema.js";

export function sourceFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Includes the actual snapshot, not just second-resolution update timestamps. */
export function learnerFingerprint(db: Db, materialId: string): string {
  const progress = db.select().from(materialProgress).where(eq(materialProgress.materialId, materialId)).get();
  return sourceFingerprint(JSON.stringify(progress ?? null));
}

export function latestPublishedCardForLesson(db: Db, lessonId: string): TeachingCard | undefined {
  const rows = db.select().from(lessonCardVersions).where(eq(lessonCardVersions.lessonId, lessonId)).all();
  if (rows.length === 0) return undefined;
  return TeachingCardSchema.parse(JSON.parse(rows.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0]!.payload));
}

export function readPublishedCard(db: Db, version: string): TeachingCard | undefined {
  const row = db.select().from(lessonCardVersions).where(eq(lessonCardVersions.version, version)).get();
  return row ? TeachingCardSchema.parse(JSON.parse(row.payload)) : undefined;
}

/** Called only after semantic review. This transaction proves structural/version eligibility, not semantic truth. */
export function publishTeachingCard(db: Db, taskId: string, generation: number, input: TeachingCard, now = new Date()): boolean {
  const card = TeachingCardSchema.parse(input);
  return db.transaction((tx) => {
    const task = tx.select().from(prepTasks).where(eq(prepTasks.id, taskId)).get();
    if (!task || task.status !== "running" || task.generation !== generation ||
        !task.leaseUntil || task.leaseUntil.getTime() <= now.getTime() || task.rulesVersion !== card.rulesVersion) return false;
    const lesson = tx.select().from(lessons).where(eq(lessons.id, card.lessonId)).get();
    if (!lesson || lesson.chunkId !== task.chunkId) return false;
    const chunk = tx.select().from(materialChunks).where(eq(materialChunks.id, lesson.chunkId)).get();
    if (!chunk || chunk.materialId !== lesson.materialId || sourceFingerprint(chunk.content) !== card.sourceHash ||
        learnerFingerprint(tx, lesson.materialId) !== card.learnerVersion) return false;
    if (card.knowledge.some((kp) => kp.evidence.some((quote) => !chunk.content.includes(quote)))) return false;
    if (!hasPassingCardReview(tx, taskId, card)) return false;
    const existing = tx.select().from(lessonCardVersions).where(eq(lessonCardVersions.version, card.version)).get();
    const payload = JSON.stringify(card);
    if (existing) return existing.taskId === taskId && existing.payload === payload;
    tx.insert(lessonCardVersions).values({ version: card.version, lessonId: card.lessonId,
      taskId, sourceHash: card.sourceHash, learnerVersion: card.learnerVersion,
      rulesVersion: card.rulesVersion, payload, publishedAt: now }).run();
    return true;
  });
}

/** Once bound, a session cannot silently switch to a newer publication. */
export function bindSessionCard(db: Db, sessionId: string, version: string): boolean {
  return db.transaction((tx) => {
    const card = readPublishedCard(tx, version);
    const session = tx.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!card || !session || session.lessonId !== card.lessonId) return false;
    if (session.cardVersion !== null) return session.cardVersion === version;
    return tx.update(sessions).set({ cardVersion: version }).where(and(eq(sessions.id, sessionId), isNull(sessions.cardVersion)))
      .returning().get() !== undefined;
  });
}
