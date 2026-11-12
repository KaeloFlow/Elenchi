import { randomUUID } from "node:crypto";
import { eq, asc, inArray } from "drizzle-orm";
import type { Db, DbTx } from "../db/client.js";
import { sessions, messages } from "../db/schema.js";
import { latestPublishedCardForLesson } from "../prep/publication.js";
import { getChunkById } from "../materials/store.js";
import type { LessonRecord } from "../prep/store.js";

export interface SessionRecord {
  id: string;
  materialId: string;
  chunkId: string;
  /** Null on v2 legacy sessions (read-only). */
  lessonId: string | null;
  /** Immutable published teaching card used by this session, when quality-prepared. */
  cardVersion: string | null;
  startedAt: number;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

/**
 * Sole owner of sessions/messages persistence. v3: a session anchors to
 * exactly one lesson of the course-prep layer; a lesson has at
 * most one session. Creation goes exclusively through
 * insertSessionWithOpening (session + tutor opening in one transaction);
 * lookup is the read-only findSessionByLessonId. Legacy chunk-anchored v2
 * sessions (lessonId null) are read-only — the routes layer rejects POSTs
 * with 409.
 */
export function findSessionByLessonId(
  db: Db,
  lessonId: string,
): SessionRecord | undefined {
  const existing = db
    .select()
    .from(sessions)
    .where(eq(sessions.lessonId, lessonId))
    .get();
  return existing ? toSessionRecord(existing) : undefined;
}

/**
 * Persists a newly created session together with its tutor-generated opening
 * message in one transaction (the opening generation must have succeeded
 * before this runs — a failure leaves no session row).
 */
export function insertSessionWithOpening(
  db: Db,
  lesson: LessonRecord,
  openingContent: string,
): SessionRecord {
  const id = randomUUID();
  const startedAt = new Date();
  return db.transaction((tx) => {
    const card = latestPublishedCardForLesson(tx, lesson.id);
    tx.insert(sessions)
      .values({
        id,
        materialId: lesson.materialId,
        chunkId: lesson.chunkId,
        lessonId: lesson.id,
        cardVersion: card?.version ?? null,
        startedAt,
      })
      .run();
    insertMessage(tx, id, "assistant", openingContent, startedAt);
    return {
      id,
      materialId: lesson.materialId,
      chunkId: lesson.chunkId,
      lessonId: lesson.id,
        cardVersion: card?.version ?? null,
      startedAt: startedAt.getTime(),
    };
  });
}

export function getSession(db: Db, sessionId: string): SessionRecord | undefined {
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  return row ? toSessionRecord(row) : undefined;
}

export function listMessages(db: Db, sessionId: string): MessageRecord[] {
  return db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt))
    .all()
    .map(toMessageRecord);
}

/**
 * Persists one user/assistant exchange atomically: a single transaction
 * writes both rows or neither (see the send-failure rollback fix — the
 * route only calls this after the LLM stream succeeded, so a failed send
 * leaves no orphan user row). The assistant row's createdAt is 1ms after
 * the user row to keep listMessages' ascending-createdAt order contract
 * (same-millisecond rows would make the pair's order ambiguous).
 *
 * The optional `onPersisted` hook runs inside the same transaction after
 * both message rows exist, so callers (the pedagogy pipeline) can write
 * session-scoped evidence rows atomically with the exchange. If the hook
 * throws, the whole transaction rolls back — no partial state.
 */
export function appendExchange(
  db: Db,
  sessionId: string,
  userContent: string,
  assistantContent: string,
  onPersisted?: (
    tx: DbTx,
    saved: { user: MessageRecord; assistant: MessageRecord },
  ) => void,
): { user: MessageRecord; assistant: MessageRecord } {
  const userCreatedAt = new Date();
  const assistantCreatedAt = new Date(userCreatedAt.getTime() + 1);

  return db.transaction((tx) => {
    const user = insertMessage(tx, sessionId, "user", userContent, userCreatedAt);
    const assistant = insertMessage(
      tx,
      sessionId,
      "assistant",
      assistantContent,
      assistantCreatedAt,
    );
    const saved = { user, assistant };
    onPersisted?.(tx, saved);
    return saved;
  });
}

function insertMessage(
  db: Db,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  createdAt: Date,
): MessageRecord {
  const id = randomUUID();
  db.insert(messages).values({ id, sessionId, role, content, createdAt }).run();
  return { id, sessionId, role, content, createdAt: createdAt.getTime() };
}

/**
 * Deletes every session (and its messages) anchored to a material. Returns
 * the deleted sessionIds so the caller can cascade flashcard deletion —
 * flashcards reference sessions, so their ids must be collected before the
 * sessions rows go away. Runs on a caller-owned transaction (materials/
 * routes.ts composes the full material cascade; putting it here keeps the
 * sessions/messages owner in dialogue/store.ts without a store-level
 * dependency cycle with materials/store.ts).
 */
export function deleteSessionsAndMessages(
  tx: DbTx,
  materialId: string,
): string[] {
  const sessionIds = tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.materialId, materialId))
    .all()
    .map((row) => row.id);
  if (sessionIds.length > 0) {
    tx.delete(messages).where(inArray(messages.sessionId, sessionIds)).run();
  }
  tx.delete(sessions).where(eq(sessions.materialId, materialId)).run();
  return sessionIds;
}

function toSessionRecord(row: {
  id: string;
  materialId: string;
  chunkId: string;
  lessonId: string | null;
  cardVersion: string | null;
  startedAt: Date;
}): SessionRecord {
  return {
    id: row.id,
    materialId: row.materialId,
    chunkId: row.chunkId,
    lessonId: row.lessonId,
    cardVersion: row.cardVersion,
    startedAt: row.startedAt.getTime(),
  };
}

function toMessageRecord(row: {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}): MessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.getTime(),
  };
}
