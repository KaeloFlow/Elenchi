import { z } from "zod";

/**
 * v3 course-prep contracts consumed by the web client. A chapter chunk is
 * "prepared" into an ordered knowledge-point list grouped into lessons
 * (3–7 KPs by default); sessions anchor to lessons, not chunks.
 */

export const PrepStatusSchema = z.enum(["not_prepared", "ready", "failed"]);
export type PrepStatus = z.infer<typeof PrepStatusSchema>;

export const LessonStatusSchema = z.enum(["active", "completed"]);
export type LessonStatus = z.infer<typeof LessonStatusSchema>;

export const LessonSchema = z.object({
  id: z.string(),
  order: z.number(),
  title: z.string(),
  objective: z.string(),
  /** Number of knowledge points in this lesson. */
  kpCount: z.number(),
  /** Derived at read time: lesson KPs ∩ material_progress.masteredKpIds. */
  masteredKpCount: z.number(),
  status: LessonStatusSchema,
  /**
   * Lesson gate (server-computed, single owner): true when the previous
   * lesson in the same chapter exists and is not completed. A locked lesson
   * cannot create its first session (AI prep needs the previous round's
   * carry-out); lessons with an existing session stay revisit-able.
   */
  locked: z.boolean(),
  /** Latest immutable published teaching-card version, null for legacy/unpublished lessons. */
  cardVersion: z.string().nullable().default(null),
});
export type LessonDto = z.infer<typeof LessonSchema>;

export const ChunkLessonsResponseSchema = z.object({
  status: PrepStatusSchema,
  /** Present and >0 when status=ready with sections still having audit gaps. */
  partialSections: z.number().optional(),
  lessons: z.array(LessonSchema).optional(),
  /** Present when status=failed: the recorded prep error. */
  error: z.string().optional(),
});
export type ChunkLessonsResponse = z.infer<typeof ChunkLessonsResponseSchema>;

export const PrepareChunkResponseSchema = z.object({
  status: PrepStatusSchema,
  kpCount: z.number().optional(),
  lessonCount: z.number().optional(),
  partialSections: z.number().optional(),
  error: z.string().optional(),
});
export type PrepareChunkResponse = z.infer<typeof PrepareChunkResponseSchema>;

/** One knowledge point of a lesson with its live mastery state (workbench). */
export const LessonKpSchema = z.object({
  id: z.string(),
  statement: z.string(),
  mastered: z.boolean(),
});
export type LessonKpDto = z.infer<typeof LessonKpSchema>;

export const LessonKpsResponseSchema = z.object({
  kps: z.array(LessonKpSchema),
});
export type LessonKpsResponse = z.infer<typeof LessonKpsResponseSchema>;

export const LessonQualitySummarySchema = z.object({
  lessonId: z.string(), cardVersion: z.string().nullable(), taskCount: z.number().int().nonnegative(),
  requirementCount: z.number().int().nonnegative(), independentRequirementCount: z.number().int().nonnegative(),
}).strict();
export type LessonQualitySummary = z.infer<typeof LessonQualitySummarySchema>;

export const SessionEvidenceProgressSchema = z.object({
  sessionId: z.string(), cardVersion: z.string().nullable(), totalRequirementCount: z.number().int().nonnegative(),
  satisfiedRequirementCount: z.number().int().nonnegative(), uncertainRequirementCount: z.number().int().nonnegative(),
  notSatisfiedRequirementCount: z.number().int().nonnegative(),
}).strict();
export type SessionEvidenceProgress = z.infer<typeof SessionEvidenceProgressSchema>;

export const SessionMisconceptionSchema = z.object({ label: z.string(), kpId: z.string().nullable(), status: z.enum(["active", "uncertain", "resolved"]) }).strict();
export const SessionMisconceptionsResponseSchema = z.object({ sessionId: z.string(), records: z.array(SessionMisconceptionSchema) }).strict();
export type SessionMisconceptionsResponse = z.infer<typeof SessionMisconceptionsResponseSchema>;
