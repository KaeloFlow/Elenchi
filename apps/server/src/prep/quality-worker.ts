import type { Db } from "../db/client.js";
import { getChunkById } from "../materials/store.js";
import { readSettings } from "../settings/store.js";
import { getPrepTask, pauseOwnedPrepTask } from "./task-store.js";
import { persistQualityResult, readQualityResult } from "./quality-result-store.js";
import { persistCandidateCards, readCandidateCards } from "./quality-card-store.js";
import { learnerFingerprint } from "./publication.js";
import { reviewTeachingCard } from "./review.js";
import { materializeAndPublishQualityCards } from "./quality-materialize.js";
import { prepareKnowledgeUnits, knowledgePreparationInputHash, KNOWLEDGE_RULES_VERSION, QUALITY_PREPARATION_RUNTIME } from "./knowledge-preparation.js";

function reviewEvidenceContext(card: { objective: string; knowledge: Array<{ id: string; statement: string; type: string; evidence: string[]; conditions: string[]; exceptions: string[] }>; requirements: Array<{ id: string; kpId: string; criterion: string }>; tasks: Array<{ id: string; requirementIds: string[]; question: string; rubric: string }> }): string {
  return JSON.stringify({ objective: card.objective, knowledge: card.knowledge.map(({ id, statement, type, evidence, conditions, exceptions }) => ({ id, statement, type, evidence, conditions, exceptions })), requirements: card.requirements, tasks: card.tasks });
}

function qualityFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "prep_context_budget_exceeded") return "review_context_budget_exceeded";
  if (message === "prep_call_budget_unavailable") return "budget_exhausted";
  if (message.startsWith("LLM 请求失败")) return "llm_request_failed";
  if (message.startsWith("LLM 连接失败")) return "llm_connection_failed";
  if (message.startsWith("semantic_review_")) return message;
  return message.startsWith("review_") ? message : "quality_worker_failed";
}

export async function runQualityPrepTask(db: Db, dataDir: string, taskId: string): Promise<void> {
  const task = getPrepTask(db, taskId);
  if (!task || task.status !== "queued") return;
  const chunk = getChunkById(db, task.chunkId);
  const settings = readSettings(dataDir);
  if (!chunk || !settings) {
    pauseOwnedPrepTask(db, task.id, task.generation, "missing_chunk_or_llm_settings");
    return;
  }
  try {
    const budget = JSON.parse(task.budget) as { maxCalls: number; maxTokens: number; maxDurationMs: number; maxRepairs: number };
    const params = { source: chunk.content, baseUrl: settings.baseUrl, model: settings.model,
      ...QUALITY_PREPARATION_RUNTIME };
    if (task.inputHash !== knowledgePreparationInputHash(params) || task.rulesVersion !== KNOWLEDGE_RULES_VERSION) {
      pauseOwnedPrepTask(db, task.id, task.generation, "task_input_identity_mismatch");
      return;
    }
    await prepareKnowledgeUnits({ db, chunkId: chunk.id, apiKey: settings.apiKey,
      budget, ...params, beforeFinish: async (outputs, generation) => {
        if (!persistQualityResult(db, { taskId: task.id, generation, units: outputs, sectionTitle: chunk.title, sourceHash: task.inputHash })) return false;
        const result = readQualityResult(db, task.id, task.inputHash);
        if (!result || !persistCandidateCards(db, { taskId: task.id, generation, sourceHash: task.inputHash,
          source: chunk.content, rulesVersion: task.rulesVersion, learnerVersion: learnerFingerprint(db, chunk.materialId), result })) return false;
        const cards = readCandidateCards(db, task.id, task.inputHash);
        if (!cards) return false;
        for (const card of cards) {
          const review = await reviewTeachingCard({ db, taskId: task.id, generation, card, source: chunk.content,
            reviewContext: reviewEvidenceContext(card), baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, signal: new AbortController().signal,
            contextTokens: QUALITY_PREPARATION_RUNTIME.reviewContextTokens, maxOutputTokens: QUALITY_PREPARATION_RUNTIME.reviewMaxOutputTokens });
          if (review.status !== "passed") throw new Error(`semantic_review_${review.status}`);
        }
        return materializeAndPublishQualityCards(db, { taskId: task.id, generation, chunkId: chunk.id,
          materialId: chunk.materialId, cards, result });
      } });
  } catch (error) {
    const current = getPrepTask(db, task.id);
    if (current?.status === "running") pauseOwnedPrepTask(db, task.id, current.generation, qualityFailureReason(error));
  }
}
