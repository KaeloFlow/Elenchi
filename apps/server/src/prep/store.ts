import { randomUUID } from "node:crypto";
import { eq, asc, inArray } from "drizzle-orm";
import type { Db, DbTx } from "../db/client.js";
import {
  knowledgePoints,
  lessons,
  chunkPrep,
  materialProgress,
  type KnowledgePointType,
} from "../db/schema.js";
import type { KnowledgeType } from "@elenchi/shared";

/**
 * Sole owner of the v3 course-prep persistence: knowledge_points, lessons,
 * chunk_prep, and material_progress. Invariant: material_progress is a
 * replayable snapshot of session_turns (KP mastered = one solid assessment
 * coverage) — same pattern as session_pedagogy_state.
 */

export interface KpInput {
  statement: string;
  type: KnowledgePointType | KnowledgeType;
  sectionIndex: number;
  sectionTitle: string;
  evidence: string[];
}

/**
 * A scheduled lesson produced by the prep pipeline. kpIndices reference
 * positions (0-based) in the ordered kps array of the same insert — the
 * scheduler works on indices, the DB stores id lists.
 */
export interface LessonInput {
  title: string;
  objective: string;
  kpIndices: number[];
  /** Persisted origin: deterministic fallback rather than accepted LLM plan. */
  autoPacked?: boolean;
}

export interface InsertPrepResultsInput {
  chunkId: string;
  materialId: string;
  kps: KpInput[];
  lessons: LessonInput[];
  partialSections: number;
  autoPackedLessons: number;
}

export interface KpRecord {
  id: string;
  materialId: string;
  chunkId: string;
  order: number;
  statement: string;
  type: KnowledgePointType;
  sectionIndex: number;
  sectionTitle: string;
  evidence: string[];
}

export interface LessonRecord {
  id: string;
  materialId: string;
  chunkId: string;
  order: number;
  title: string;
  objective: string;
  kpIds: string[];
  carryOutSummary: string | null;
  autoPacked: boolean;
  status: "active" | "completed";
  completedAt: Date | null;
}

export interface ChunkPrepRecord {
  chunkId: string;
  materialId: string;
  status: "ready" | "failed";
  kpCount: number;
  lessonCount: number;
  partialSections: number;
  autoPackedLessons: number;
  error: string | null;
  preparedAt: Date;
}

export interface MaterialProgressRecord {
  materialId: string;
  masteredKpIds: string[];
  openMisconceptions: string[];
}

/**
 * Writes the full prep result of one chapter in a single transaction. Any
 * previous KP/lesson rows for the chunk are deleted first, so a retry after
 * a failed attempt always starts clean.
 */
export function insertPrepResults(
  db: Db,
  input: InsertPrepResultsInput,
): { kpIds: string[]; lessonIds: string[] } {
  const kpIds = input.kps.map(() => randomUUID());
  const lessonIds = input.lessons.map(() => randomUUID());
  const now = new Date();

  db.transaction((tx) => {
    deletePrepForChunk(tx, input.chunkId);

    input.kps.forEach((kp, index) => {
      tx.insert(knowledgePoints)
        .values({
          id: kpIds[index]!,
          materialId: input.materialId,
          chunkId: input.chunkId,
          order: index + 1,
          statement: kp.statement,
          type: kp.type,
          sectionIndex: kp.sectionIndex,
          sectionTitle: kp.sectionTitle,
          evidence: JSON.stringify(kp.evidence),
          createdAt: now,
        })
        .run();
    });

    input.lessons.forEach((lesson, index) => {
      tx.insert(lessons)
        .values({
          id: lessonIds[index]!,
          materialId: input.materialId,
          chunkId: input.chunkId,
          order: index + 1,
          title: lesson.title,
          objective: lesson.objective,
          kpIds: JSON.stringify(lesson.kpIndices.map((i) => kpIds[i]!)),
          autoPacked: lesson.autoPacked ?? false,
          status: "active",
          createdAt: now,
        })
        .run();
    });

    tx.insert(chunkPrep)
      .values({
        chunkId: input.chunkId,
        materialId: input.materialId,
        status: "ready",
        kpCount: input.kps.length,
        lessonCount: input.lessons.length,
        partialSections: input.partialSections,
        autoPackedLessons: input.autoPackedLessons,
        preparedAt: now,
      })
      .run();
  });

  return { kpIds, lessonIds };
}

/** Records a failed prep attempt (retryable — a failed row is never ready). */
export function recordPrepFailure(
  db: Db,
  input: { chunkId: string; materialId: string; error: string },
): void {
  db.transaction((tx) => {
    deletePrepForChunk(tx, input.chunkId);
    tx.insert(chunkPrep)
      .values({
        chunkId: input.chunkId,
        materialId: input.materialId,
        status: "failed",
        kpCount: 0,
        lessonCount: 0,
        partialSections: 0,
        autoPackedLessons: 0,
        error: input.error,
        preparedAt: new Date(),
      })
      .run();
  });
}

export function getChunkPrep(
  db: Db,
  chunkId: string,
): ChunkPrepRecord | undefined {
  const row = db
    .select()
    .from(chunkPrep)
    .where(eq(chunkPrep.chunkId, chunkId))
    .get();
  return row ? toChunkPrepRecord(row) : undefined;
}

export function listLessons(db: Db, chunkId: string): LessonRecord[] {
  return db
    .select()
    .from(lessons)
    .where(eq(lessons.chunkId, chunkId))
    .orderBy(asc(lessons.order))
    .all()
    .map(toLessonRecord);
}

export function getLessonById(
  db: Db,
  lessonId: string,
): LessonRecord | undefined {
  const row = db.select().from(lessons).where(eq(lessons.id, lessonId)).get();
  return row ? toLessonRecord(row) : undefined;
}

/** KPs of one lesson, in lesson order (resolved via the kpIds list). */
export function getLessonKps(db: Db, lesson: LessonRecord): KpRecord[] {
  if (lesson.kpIds.length === 0) return [];
  const rows = db
    .select()
    .from(knowledgePoints)
    .where(inArray(knowledgePoints.id, lesson.kpIds))
    .all();
  const byId = new Map(rows.map((row) => [row.id, toKpRecord(row)]));
  return lesson.kpIds
    .map((id) => byId.get(id))
    .filter((kp): kp is KpRecord => kp !== undefined);
}

/**
 * Lesson gate state for one lesson, derived at read time from the previous
 * lesson row (same chunk, order-1). The lessons table stays free of learner
 * gating state — the rule has a single owner here and both the lessons list
 * endpoint and the create-session gate read it.
 * Authority: lesson-gate feature (2026-09 gate: AI prep needs the previous
 * round's carry-out).
 */
export interface LessonLockState {
  locked: boolean;
  /** Present when locked: title of the blocking previous lesson. */
  previousLessonTitle: string | null;
  previousLessonOrder: number | null;
}

export function getLessonLockState(
  db: Db,
  lesson: LessonRecord,
): LessonLockState {
  if (lesson.order <= 1) {
    return { locked: false, previousLessonTitle: null, previousLessonOrder: null };
  }
  const previous = db
    .select()
    .from(lessons)
    .where(eq(lessons.chunkId, lesson.chunkId))
    .all()
    .find((l) => l.order === lesson.order - 1);
  // Fail-open on a gap (previous row missing): gating only when a real
  // previous lesson is still incomplete.
  if (!previous) {
    return { locked: false, previousLessonTitle: null, previousLessonOrder: null };
  }
  const locked = previous.status !== "completed";
  return {
    locked,
    previousLessonTitle: locked ? previous.title : null,
    previousLessonOrder: locked ? previous.order : null,
  };
}

/**
 * Mastered KP ids for one lesson = lesson.kpIds ∩ material progress.
 * Read-time derivation keeps the lessons table free of learner state.
 */
export function countMasteredForLesson(
  db: Db,
  lesson: LessonRecord,
): number {
  const progress = getMaterialProgress(db, lesson.materialId);
  const mastered = new Set(progress.masteredKpIds);
  return lesson.kpIds.filter((id) => mastered.has(id)).length;
}

/**
 * Marks the lesson completed and stores the deterministic carry-out summary
 * inside the caller's transaction (the send pipeline's persist step).
 */
export function markLessonCompleted(
  tx: DbTx,
  lessonId: string,
  carryOutSummary: string,
): void {
  tx.update(lessons)
    .set({ status: "completed", completedAt: new Date(), carryOutSummary })
    .where(eq(lessons.id, lessonId))
    .run();
}

export function getCarryOutSummary(
  db: Db,
  chunkId: string,
  lessonOrder: number,
): string | null {
  const row = db
    .select()
    .from(lessons)
    .where(eq(lessons.chunkId, chunkId))
    .all()
    .find((l) => l.order === lessonOrder - 1);
  return row?.carryOutSummary ?? null;
}

export function getMaterialProgress(
  db: Db,
  materialId: string,
): MaterialProgressRecord {
  const row = db
    .select()
    .from(materialProgress)
    .where(eq(materialProgress.materialId, materialId))
    .get();
  return {
    materialId,
    masteredKpIds: row ? (JSON.parse(row.masteredKpIds) as string[]) : [],
    openMisconceptions: row
      ? (JSON.parse(row.openMisconceptions) as string[])
      : [],
  };
}

/**
 * Upserts the progress snapshot. Must run inside the send pipeline's persist
 * transaction so turns (source of truth) and the snapshot never diverge.
 */
export function updateMaterialProgress(
  tx: DbTx,
  materialId: string,
  masteredKpIds: string[],
  openMisconceptions: string[],
): void {
  tx.insert(materialProgress)
    .values({
      materialId,
      masteredKpIds: JSON.stringify(masteredKpIds),
      openMisconceptions: JSON.stringify(openMisconceptions),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: materialProgress.materialId,
      set: {
        masteredKpIds: JSON.stringify(masteredKpIds),
        openMisconceptions: JSON.stringify(openMisconceptions),
        updatedAt: new Date(),
      },
    })
    .run();
}

/**
 * Cascade support for material deletion, called inside the materials delete
 * transaction (same pattern as deletePedagogyForSessions).
 */
export function deletePrepForMaterial(tx: DbTx, materialId: string): void {
  tx.delete(knowledgePoints)
    .where(eq(knowledgePoints.materialId, materialId))
    .run();
  tx.delete(lessons).where(eq(lessons.materialId, materialId)).run();
  tx.delete(chunkPrep).where(eq(chunkPrep.materialId, materialId)).run();
  tx.delete(materialProgress)
    .where(eq(materialProgress.materialId, materialId))
    .run();
}

function deletePrepForChunk(tx: DbTx, chunkId: string): void {
  tx.delete(knowledgePoints).where(eq(knowledgePoints.chunkId, chunkId)).run();
  tx.delete(lessons).where(eq(lessons.chunkId, chunkId)).run();
  tx.delete(chunkPrep).where(eq(chunkPrep.chunkId, chunkId)).run();
}

function toKpRecord(row: {
  id: string;
  materialId: string;
  chunkId: string;
  order: number;
  statement: string;
  type: string;
  sectionIndex: number;
  sectionTitle: string;
  evidence: string;
}): KpRecord {
  return {
    id: row.id,
    materialId: row.materialId,
    chunkId: row.chunkId,
    order: row.order,
    statement: row.statement,
    type: row.type as KnowledgePointType,
    sectionIndex: row.sectionIndex,
    sectionTitle: row.sectionTitle,
    evidence: JSON.parse(row.evidence) as string[],
  };
}

function toLessonRecord(row: {
  id: string;
  materialId: string;
  chunkId: string;
  order: number;
  title: string;
  objective: string;
  kpIds: string;
  carryOutSummary: string | null;
  autoPacked: number | boolean;
  status: string;
  completedAt: Date | null;
}): LessonRecord {
  return {
    id: row.id,
    materialId: row.materialId,
    chunkId: row.chunkId,
    order: row.order,
    title: row.title,
    objective: row.objective,
    kpIds: JSON.parse(row.kpIds) as string[],
    carryOutSummary: row.carryOutSummary,
    autoPacked: Boolean(row.autoPacked),
    status: row.status as "active" | "completed",
    completedAt: row.completedAt,
  };
}

function toChunkPrepRecord(row: {
  chunkId: string;
  materialId: string;
  status: string;
  kpCount: number;
  lessonCount: number;
  partialSections: number;
  autoPackedLessons: number;
  error: string | null;
  preparedAt: Date;
}): ChunkPrepRecord {
  return {
    chunkId: row.chunkId,
    materialId: row.materialId,
    status: row.status as "ready" | "failed",
    kpCount: row.kpCount,
    lessonCount: row.lessonCount,
    partialSections: row.partialSections,
    autoPackedLessons: row.autoPackedLessons,
    error: row.error,
    preparedAt: row.preparedAt,
  };
}
