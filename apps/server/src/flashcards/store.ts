import { randomUUID } from "node:crypto";
import { eq, asc, inArray } from "drizzle-orm";
import type { Db, DbTx } from "../db/client.js";
import { flashcards } from "../db/schema.js";
import type { ExtractedFlashcard } from "@elenchi/shared";

export interface FlashcardRecord {
  id: string;
  sessionId: string;
  question: string;
  options: string[] | null;
  answer: string;
  explanation: string | null;
  createdAt: number;
}

/**
 * Sole owner of flashcards persistence. `options` is stored as a JSON string
 * (see db/schema.ts `flashcards.options: text("options")`) because SQLite has
 * no native array column; this module is the only place that (de)serializes
 * it, so callers always see a real string[] | null.
 */
export function insertFlashcards(
  db: Db,
  sessionId: string,
  cards: ExtractedFlashcard[],
): FlashcardRecord[] {
  const createdAt = new Date();
  const rows = cards.map((card) => ({
    id: randomUUID(),
    sessionId,
    question: card.question,
    options: card.options ?? null,
    answer: card.answer,
    explanation: card.explanation ?? null,
    createdAt,
  }));

  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(flashcards)
        .values({
          id: row.id,
          sessionId: row.sessionId,
          question: row.question,
          options: row.options ? JSON.stringify(row.options) : null,
          answer: row.answer,
          explanation: row.explanation,
          createdAt: row.createdAt,
        })
        .run();
    }
  });

  return rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() }));
}

export function listFlashcards(db: Db, sessionId: string): FlashcardRecord[] {
  return db
    .select()
    .from(flashcards)
    .where(eq(flashcards.sessionId, sessionId))
    .orderBy(asc(flashcards.createdAt))
    .all()
    .map(toRecord);
}

export function getFlashcard(db: Db, id: string): FlashcardRecord | undefined {
  const row = db.select().from(flashcards).where(eq(flashcards.id, id)).get();
  return row ? toRecord(row) : undefined;
}

export interface FlashcardUpdate {
  question?: string;
  options?: string[] | null;
  answer?: string;
  explanation?: string | null;
}

export function updateFlashcard(
  db: Db,
  id: string,
  update: FlashcardUpdate,
): FlashcardRecord | undefined {
  const existing = getFlashcard(db, id);
  if (!existing) return undefined;

  const values: {
    question?: string;
    options?: string | null;
    answer?: string;
    explanation?: string | null;
  } = {};
  if (update.question !== undefined) values.question = update.question;
  if (update.options !== undefined) {
    values.options = update.options ? JSON.stringify(update.options) : null;
  }
  if (update.answer !== undefined) values.answer = update.answer;
  if (update.explanation !== undefined) values.explanation = update.explanation;

  db.update(flashcards).set(values).where(eq(flashcards.id, id)).run();
  return getFlashcard(db, id);
}

export function deleteFlashcard(db: Db, id: string): boolean {
  const existing = getFlashcard(db, id);
  if (!existing) return false;
  db.delete(flashcards).where(eq(flashcards.id, id)).run();
  return true;
}

/**
 * Deletes every flashcard belonging to the given sessions. Used by the
 * material cascade in materials/routes.ts; runs on a caller-owned
 * transaction. A no-op for an empty id list (inArray would emit invalid
 * SQL for `IN ()`).
 */
export function deleteFlashcardsForSessions(
  tx: DbTx,
  sessionIds: string[],
): void {
  if (sessionIds.length === 0) return;
  tx.delete(flashcards).where(inArray(flashcards.sessionId, sessionIds)).run();
}

function toRecord(row: {
  id: string;
  sessionId: string;
  question: string;
  options: string | null;
  answer: string;
  explanation: string | null;
  createdAt: Date;
}): FlashcardRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    question: row.question,
    options: row.options ? (JSON.parse(row.options) as string[]) : null,
    answer: row.answer,
    explanation: row.explanation,
    createdAt: row.createdAt.getTime(),
  };
}
