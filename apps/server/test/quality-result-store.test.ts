import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type DbHandle } from "../src/db/client.js";
import { ensurePrepTask, claimPrepTask, stopPrepTask } from "../src/prep/task-store.js";
import { persistQualityResult, readQualityResult } from "../src/prep/quality-result-store.js";
let h: DbHandle; let dir: string; let taskId: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "elenchi-quality-result-store-")); h = createDb(dir, { migrate: true }); taskId = ensurePrepTask(h.db, { chunkId: "c", inputHash: "source", rulesVersion: "r", budget: { maxCalls: 2, maxTokens: 100, maxDurationMs: 10000, maxRepairs: 0 } }).id; });
afterEach(() => { h.close(); rmSync(dir, { recursive: true, force: true }); });
const units = [{ sourceStart: 0, sourceEnd: 2, points: [{ statement: "命题", type: "concept" as const, evidence: ["原文"], conditions: [], exceptions: [] }] }];
describe("quality result checkpoint", () => {
  it("persists the final candidate only under the active generation", () => {
    const claimed = claimPrepTask(h.db, taskId)!;
    expect(persistQualityResult(h.db, { taskId, generation: claimed.generation, units, sectionTitle: "章", sourceHash: "source" })).toBe(true);
    expect(readQualityResult(h.db, taskId, "source")?.kps[0]?.statement).toBe("命题");
  });
  it("rejects a stale finalization after cancellation", () => {
    const claimed = claimPrepTask(h.db, taskId)!;
    stopPrepTask(h.db, taskId, "cancelled", "user");
    expect(persistQualityResult(h.db, { taskId, generation: claimed.generation, units, sectionTitle: "章", sourceHash: "source" })).toBe(false);
    expect(readQualityResult(h.db, taskId, "source")).toBeUndefined();
  });
});
