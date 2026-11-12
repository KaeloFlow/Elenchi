import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type DbHandle } from "../src/db/client.js";
import { materials, materialChunks, prepTasks, lessons, knowledgePoints, lessonCardVersions } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { knowledgePreparationInputHash } from "../src/prep/knowledge-preparation.js";
import { readQualityResult } from "../src/prep/quality-result-store.js";
import { readCandidateCards } from "../src/prep/quality-card-store.js";
import { writeSettings } from "../src/settings/store.js";
import { ensurePrepTask, getPrepTask } from "../src/prep/task-store.js";
import { runQualityPrepTask } from "../src/prep/quality-worker.js";
let h: DbHandle; let dir: string; let taskId: string; const fetchMock = vi.fn();
const response = (body: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }));
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "elenchi-quality-worker-")); h = createDb(dir, { migrate: true }); const now = new Date(); h.db.insert(materials).values({ id: "m", title: "教材", sourcePath: "x", createdAt: now }).run(); h.db.insert(materialChunks).values({ id: "c", materialId: "m", order: 1, title: "章", level: 1, content: "原文" }).run(); writeSettings(dir, { baseUrl: "http://fake", apiKey: "secret", model: "model" }); const inputHash = knowledgePreparationInputHash({ source: "原文", baseUrl: "http://fake", model: "model", maxChars: 2000, contextTokens: 12000, maxOutputTokens: 1800 }); taskId = ensurePrepTask(h.db, { chunkId: "c", inputHash, rulesVersion: "quality-knowledge-1", budget: { maxCalls: 10, maxTokens: 50000, maxDurationMs: 10000, maxRepairs: 1 } }).id; vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); h.close(); rmSync(dir, { recursive: true, force: true }); });
describe("explicit quality worker", () => {
  it("runs only when explicitly started and persists verified knowledge checkpoints", async () => {
    fetchMock.mockResolvedValueOnce(response({ points: [{ statement: "命题", type: "concept", evidence: ["原文"], conditions: [], exceptions: [] }] }))
      .mockResolvedValueOnce(response({ checks: { supportedClaims: true, conditionsPreserved: true, coreCoverage: true, validAssessment: true }, issues: [] }));
    expect(getPrepTask(h.db, taskId)?.status).toBe("queued");
    await runQualityPrepTask(h.db, dir, taskId);
    expect(getPrepTask(h.db, taskId)?.status).toBe("succeeded");
    const hash = getPrepTask(h.db, taskId)!.inputHash;
    expect(readQualityResult(h.db, taskId, hash)?.lessons).toHaveLength(1);
    expect(readCandidateCards(h.db, taskId, hash)?.[0]?.tasks).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.db.select().from(knowledgePoints).all()).toHaveLength(1);
    expect(h.db.select().from(lessons).all()).toHaveLength(1);
    expect(h.db.select().from(lessonCardVersions).all()).toHaveLength(1);
  });
  it("does not materialize or succeed when semantic review finds a gap", async () => {
    fetchMock.mockResolvedValueOnce(response({ points: [{ statement: "命题", type: "concept", evidence: ["原文"], conditions: [], exceptions: [] }] }))
      .mockResolvedValueOnce(response({ checks: { supportedClaims: false, conditionsPreserved: true, coreCoverage: true, validAssessment: true }, issues: [{ description: "无支撑", sourceQuote: "原文" }] }));
    await runQualityPrepTask(h.db, dir, taskId);
    expect(getPrepTask(h.db, taskId)?.status).toBe("paused");
    expect(h.db.select().from(lessons).all()).toHaveLength(0);
    expect(h.db.select().from(lessonCardVersions).all()).toHaveLength(0);
  });
  it("does not restart a cancelled task or call the model", async () => {
    h.db.update(prepTasks).set({ status: "cancelled" }).where(eq(prepTasks.id, taskId)).run();
    await runQualityPrepTask(h.db, dir, taskId);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("pauses instead of claiming success when the model response is invalid", async () => {
    fetchMock.mockResolvedValue(response({ points: [{ statement: "x", type: "invented", evidence: ["原文"], conditions: [], exceptions: [] }] }));
    await runQualityPrepTask(h.db, dir, taskId);
    expect(getPrepTask(h.db, taskId)?.status).toBe("paused");
    expect(getPrepTask(h.db, taskId)?.reason).toBe("unit_failed");
  });
});
