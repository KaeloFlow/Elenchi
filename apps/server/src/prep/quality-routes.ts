import type { FastifyInstance } from "fastify";
import { CreateQualityPrepInputSchema, QualityPrepTaskResponseSchema, QualityPrepTaskStatusSchema, QualityPrepChunkTaskSchema } from "@elenchi/shared";
import type { Db } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import { getChunkById } from "../materials/store.js";
import { readSettings } from "../settings/store.js";
import { countPrepCheckpoints, ensurePrepTask, getLatestPrepTaskForChunk, getPrepTask, resumePrepTask, stopPrepTask } from "./task-store.js";
import { knowledgePreparationInputHash, KNOWLEDGE_RULES_VERSION, QUALITY_PREPARATION_RUNTIME } from "./knowledge-preparation.js";
import { runQualityPrepTask } from "./quality-worker.js";

const DEFAULT_BUDGET = { maxCalls: 80, maxTokens: 120000, maxDurationMs: 180000, maxRepairs: 12 };

/** Durable task API. Creation only queues; explicit start/resume begins worker execution. */
export function registerQualityPrepRoutes(app: FastifyInstance, db: Db, config: ServerConfig): void {
  app.post("/api/chunks/:chunkId/quality-prep", async (request, reply) => {
    const { chunkId } = request.params as { chunkId: string };
    const chunk = getChunkById(db, chunkId);
    if (!chunk) { reply.code(404); return { error: "chunk_not_found" }; }
    if (!readSettings(config.dataDir)) { reply.code(400); return { error: "llm_not_configured" }; }
    const parsed = CreateQualityPrepInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: "invalid_quality_prep_options" }; }
    const input = parsed.data;
    const settings = readSettings(config.dataDir)!;
    const inputHash = knowledgePreparationInputHash({ source: chunk.content, model: settings.model,
      baseUrl: settings.baseUrl, ...QUALITY_PREPARATION_RUNTIME });
    const task = ensurePrepTask(db, { chunkId, inputHash, rulesVersion: KNOWLEDGE_RULES_VERSION, budget: input.budget ?? DEFAULT_BUDGET });
    reply.code(202);
    return QualityPrepTaskResponseSchema.parse({ taskId: task.id, status: task.status, reason: task.reason });
  });
  app.get("/api/chunks/:chunkId/quality-prep/task", async (request, reply) => {
    const { chunkId } = request.params as { chunkId: string };
    if (!getChunkById(db, chunkId)) { reply.code(404); return { error: "chunk_not_found" }; }
    const task = getLatestPrepTaskForChunk(db, chunkId);
    return QualityPrepChunkTaskSchema.parse(task ? { taskId: task.id, chunkId: task.chunkId, status: task.status,
      reason: task.reason, generation: task.generation, callsUsed: task.callsUsed, tokensUsed: task.tokensUsed,
      checkpointCount: countPrepCheckpoints(db, task.id) } : null);
  });
  app.post("/api/quality-prep/tasks/:taskId/start", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = getPrepTask(db, taskId);
    if (!task) { reply.code(404); return { error: "prep_task_not_found" }; }
    if (task.status !== "queued") { reply.code(409); return { error: "prep_task_not_startable" }; }
    void runQualityPrepTask(db, config.dataDir, taskId);
    reply.code(202);
    return QualityPrepTaskResponseSchema.parse({ taskId, status: "running", reason: null });
  });
  app.get("/api/quality-prep/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = getPrepTask(db, taskId);
    if (!task) { reply.code(404); return { error: "prep_task_not_found" }; }
    return QualityPrepTaskStatusSchema.parse({ taskId: task.id, chunkId: task.chunkId, status: task.status,
      reason: task.reason, generation: task.generation, callsUsed: task.callsUsed, tokensUsed: task.tokensUsed,
      checkpointCount: countPrepCheckpoints(db, task.id) });
  });
  app.post("/api/quality-prep/tasks/:taskId/resume", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = resumePrepTask(db, taskId);
    if (!task) { reply.code(409); return { error: "prep_task_not_resumable" }; }
    // Resume is an explicit user action and therefore the paid-work boundary.
    // Unlike creation, it must re-arm the worker or the task would remain queued.
    void runQualityPrepTask(db, config.dataDir, taskId);
    return QualityPrepTaskResponseSchema.parse({ taskId: task.id, status: "running", reason: null });
  });
  app.post("/api/quality-prep/tasks/:taskId/cancel", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = stopPrepTask(db, taskId, "cancelled", "user_cancelled");
    if (!task) { reply.code(409); return { error: "prep_task_not_cancellable" }; }
    return QualityPrepTaskResponseSchema.parse({ taskId: task.id, status: task.status, reason: task.reason });
  });
}
