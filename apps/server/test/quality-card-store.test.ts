import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type DbHandle } from "../src/db/client.js";
import { ensurePrepTask, claimPrepTask, stopPrepTask } from "../src/prep/task-store.js";
import { persistCandidateCards, readCandidateCards } from "../src/prep/quality-card-store.js";
import { buildQualityResult } from "../src/prep/quality-result.js";
let h: DbHandle; let dir: string; let taskId: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "elenchi-quality-cards-")); h = createDb(dir, { migrate: true }); taskId = ensurePrepTask(h.db, { chunkId: "c", inputHash: "source", rulesVersion: "quality-knowledge-1", budget: { maxCalls: 2, maxTokens: 100, maxDurationMs: 10000, maxRepairs: 0 } }).id; });
afterEach(() => { h.close(); rmSync(dir, { recursive: true, force: true }); });
const result = buildQualityResult([{ sourceStart: 0, sourceEnd: 2, points: [{ statement: "命题", type: "concept", evidence: ["原文"], conditions: ["条件"], exceptions: ["例外"] }] }], "章");
describe("candidate teaching card checkpoint", () => {
  it("persists a structural card candidate with conditions and no publication", () => {
    const claimed = claimPrepTask(h.db, taskId)!;
    expect(persistCandidateCards(h.db, { taskId, generation: claimed.generation, sourceHash: "source", source: "原文", rulesVersion: "quality-knowledge-1", learnerVersion: "learner", result })).toBe(true);
    const card = readCandidateCards(h.db, taskId, "source")![0]!;
    expect(card.knowledge[0]?.conditions).toEqual(["条件"]);
    expect(card.lessonId).toContain("quality-lesson:");
    expect(card.version).toContain("quality-card:");
  });
  it("does not persist candidate after cancellation", () => {
    const claimed = claimPrepTask(h.db, taskId)!; stopPrepTask(h.db, taskId, "cancelled", "user");
    expect(persistCandidateCards(h.db, { taskId, generation: claimed.generation, sourceHash: "source", source: "原文", rulesVersion: "quality-knowledge-1", learnerVersion: "learner", result })).toBe(false);
  });
});
