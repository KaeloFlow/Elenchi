import type { FastifyInstance } from "fastify";
import {
  ChunkLessonsResponseSchema,
  PrepareChunkResponseSchema,
  LessonKpsResponseSchema,
  LessonQualitySummarySchema,
} from "@elenchi/shared";
import type { Db } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import { readSettings } from "../settings/store.js";
import { getChunkById } from "../materials/store.js";
import { prepareChunk, PrepInProgressError } from "./pipeline.js";
import { latestPublishedCardForLesson } from "./publication.js";
import {
  getChunkPrep,
  listLessons,
  countMasteredForLesson,
  getLessonById,
  getLessonKps,
  getLessonLockState,
  getMaterialProgress,
} from "./store.js";

/**
 * Course-prep endpoints. Lazy per-chapter prep: POST /prepare runs the whole
 * pipeline synchronously (no background job infra in v3 — spec §3.2), GET
 * /lessons reports the prepared state without triggering anything.
 */

export function registerPrepRoutes(
  app: FastifyInstance,
  db: Db,
  config: ServerConfig,
): void {
  app.post("/api/chunks/:chunkId/prepare", async (request, reply) => {
    const { chunkId } = request.params as { chunkId: string };
    if (!getChunkById(db, chunkId)) {
      reply.code(404);
      return { error: "chunk_not_found" };
    }
    if (!readSettings(config.dataDir)) {
      reply.code(400);
      return { error: "llm_not_configured" };
    }

    try {
      const result = await prepareChunk(db, config, chunkId);
      if (result.status === "failed") {
        reply.code(502);
        return {
          error: "prep_failed",
          details: result.error,
        };
      }
      return PrepareChunkResponseSchema.parse({
        status: "ready",
        kpCount: result.kpCount,
        lessonCount: result.lessonCount,
        partialSections: result.partialSections,
      });
    } catch (err) {
      if (err instanceof PrepInProgressError) {
        reply.code(409);
        return { error: "prep_in_progress" };
      }
      reply.code(502);
      return {
        error: "prep_failed",
        details: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.get("/api/chunks/:chunkId/lessons", async (request, reply) => {
    const { chunkId } = request.params as { chunkId: string };
    if (!getChunkById(db, chunkId)) {
      reply.code(404);
      return { error: "chunk_not_found" };
    }

    const prep = getChunkPrep(db, chunkId);
    if (!prep) {
      return ChunkLessonsResponseSchema.parse({ status: "not_prepared" });
    }
    if (prep.status === "failed") {
      return ChunkLessonsResponseSchema.parse({
        status: "failed",
        error: prep.error ?? "备课失败",
      });
    }

    const lessons = listLessons(db, chunkId).map((lesson) => ({
      id: lesson.id,
      order: lesson.order,
      title: lesson.title,
      objective: lesson.objective,
      kpCount: lesson.kpIds.length,
      masteredKpCount: countMasteredForLesson(db, lesson),
      status: lesson.status,
      locked: getLessonLockState(db, lesson).locked,
      cardVersion: latestPublishedCardForLesson(db, lesson.id)?.version ?? null,
    }));
    return ChunkLessonsResponseSchema.parse({
      status: "ready",
      partialSections: prep.partialSections,
      lessons,
    });
  });

  /**
   * Workbench data: the lesson's knowledge points with live mastery marks
   * (lesson KPs ∩ material_progress.masteredKpIds — the same derivation the
   * lesson card and countMasteredForLesson use). Read-only; no LLM involved.
   */
  app.get("/api/lessons/:lessonId/quality-summary", async (request, reply) => {
    const { lessonId } = request.params as { lessonId: string };
    const lesson = getLessonById(db, lessonId);
    if (!lesson) { reply.code(404); return { error: "lesson_not_found" }; }
    const card = latestPublishedCardForLesson(db, lessonId);
    return LessonQualitySummarySchema.parse({ lessonId, cardVersion: card?.version ?? null,
      taskCount: card?.tasks.length ?? 0, requirementCount: card?.requirements.length ?? 0,
      independentRequirementCount: card?.requirements.filter((requirement) => requirement.independent).length ?? 0 });
  });

  app.get("/api/lessons/:lessonId/kps", async (request, reply) => {
    const { lessonId } = request.params as { lessonId: string };
    const lesson = getLessonById(db, lessonId);
    if (!lesson) {
      reply.code(404);
      return { error: "lesson_not_found" };
    }
    const mastered = new Set(
      getMaterialProgress(db, lesson.materialId).masteredKpIds,
    );
    const kps = getLessonKps(db, lesson).map((kp) => ({
      id: kp.id,
      statement: kp.statement,
      mastered: mastered.has(kp.id),
    }));
    return LessonKpsResponseSchema.parse({ kps });
  });
}
