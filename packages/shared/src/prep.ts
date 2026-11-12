import { z } from "zod";

/** Quality-first preparation contracts; task success never implies lesson readiness. */
export const KnowledgeTypeSchema = z.enum([
  "fact", "concept", "classification", "relation", "mechanism", "formula",
  "model", "procedure", "strategy", "proof", "evaluation", "normative",
]);
export type KnowledgeType = z.infer<typeof KnowledgeTypeSchema>;
export const PrepTaskStatusSchema = z.enum([
  "queued", "running", "paused", "succeeded", "failed", "cancelled",
]);
export const LessonReadinessSchema = z.enum(["draft", "checking", "blocked", "ready"]);
export const LearningStatusSchema = z.enum(["not_started", "in_progress", "paused", "completed"]);
export const PrepBudgetSchema = z.object({
  maxCalls: z.number().int().positive().safe(),
  maxTokens: z.number().int().positive().safe(),
  maxDurationMs: z.number().int().positive().safe(),
  maxRepairs: z.number().int().nonnegative().safe(),
}).strict();
export type PrepBudget = z.infer<typeof PrepBudgetSchema>;
export const PrepTaskSchema = z.object({
  id: z.string().min(1),
  chunkId: z.string().min(1),
  inputHash: z.string().min(1),
  rulesVersion: z.string().min(1),
  status: PrepTaskStatusSchema,
  generation: z.number().int().nonnegative().safe(),
  reason: z.string().nullable(),
  budget: PrepBudgetSchema,
  callsUsed: z.number().int().nonnegative().safe(),
  tokensUsed: z.number().int().nonnegative().safe(),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
}).strict();
export type PrepTask = z.infer<typeof PrepTaskSchema>;
export const CreateQualityPrepInputSchema = z.object({
  budget: PrepBudgetSchema.optional(),
}).strict();
export const QualityPrepTaskResponseSchema = z.object({
  taskId: z.string().min(1), status: PrepTaskStatusSchema,
  reason: z.string().nullable(),
}).strict();
export const QualityPrepTaskStatusSchema = z.object({
  taskId: z.string().min(1), chunkId: z.string().min(1), status: PrepTaskStatusSchema,
  reason: z.string().nullable(), generation: z.number().int().nonnegative(),
  callsUsed: z.number().int().nonnegative(), tokensUsed: z.number().int().nonnegative(),
  checkpointCount: z.number().int().nonnegative(),
}).strict();
export const QualityPrepChunkTaskSchema = QualityPrepTaskStatusSchema.nullable();
