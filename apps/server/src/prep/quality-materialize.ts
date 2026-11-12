import { eq } from "drizzle-orm";
import type { TeachingCard } from "@elenchi/shared";
import type { Db } from "../db/client.js";
import { chunkPrep, knowledgePoints, lessons, prepTasks } from "../db/schema.js";
import type { StoredQualityResult } from "./quality-result-store.js";
import { publishTeachingCard } from "./publication.js";

/** Materializes only already-reviewed cards. It never replaces an existing chunk's course. */
export function materializeAndPublishQualityCards(db: Db, input: {
  taskId: string; generation: number; chunkId: string; materialId: string;
  cards: TeachingCard[]; result: StoredQualityResult;
}): boolean {
  return db.transaction((tx) => {
    const task = tx.select().from(prepTasks).where(eq(prepTasks.id, input.taskId)).get();
    if (!task || task.status !== "running" || task.generation !== input.generation || !task.leaseUntil || task.leaseUntil <= new Date()) return false;
    // Existing v3 result is live state owned by the old prep pipeline. It is not
    // silently replaced by a quality task before the separately-confirmed reset.
    if (tx.select().from(chunkPrep).where(eq(chunkPrep.chunkId, input.chunkId)).get()) return false;
    for (const kp of input.result.kps) {
      const existing = tx.select().from(knowledgePoints).where(eq(knowledgePoints.id, kp.id)).get();
      if (existing) {
        if (existing.chunkId !== input.chunkId || existing.statement !== kp.statement) return false;
        continue;
      }
      tx.insert(knowledgePoints).values({ id: kp.id, materialId: input.materialId, chunkId: input.chunkId,
        order: input.result.kps.indexOf(kp) + 1, statement: kp.statement, type: kp.type,
        sectionIndex: kp.sectionIndex, sectionTitle: kp.sectionTitle, evidence: JSON.stringify(kp.evidence), createdAt: new Date() }).run();
    }
    for (const [index, card] of input.cards.entries()) {
      const candidate = input.result.lessons[index];
      if (!candidate || candidate.kpIds.length !== card.knowledge.length) return false;
      const existing = tx.select().from(lessons).where(eq(lessons.id, card.lessonId)).get();
      if (!existing) tx.insert(lessons).values({ id: card.lessonId, materialId: input.materialId, chunkId: input.chunkId,
        order: index + 1, title: candidate.lesson.title, objective: candidate.lesson.objective,
        kpIds: JSON.stringify(candidate.kpIds), autoPacked: candidate.lesson.autoPacked, status: "active", createdAt: new Date() }).run();
      if (!publishTeachingCard(tx, input.taskId, input.generation, card)) throw new Error("quality_card_publication_rejected");
    }
    tx.insert(chunkPrep).values({ chunkId: input.chunkId, materialId: input.materialId, status: "ready",
      kpCount: input.result.kps.length, lessonCount: input.cards.length, partialSections: 0,
      autoPackedLessons: input.result.lessons.filter(({ lesson }) => lesson.autoPacked).length, preparedAt: new Date() }).run();
    return true;
  });
}
