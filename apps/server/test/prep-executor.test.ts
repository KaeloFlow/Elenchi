import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDb, type DbHandle } from "../src/db/client.js";
import { ensurePrepTask, resumePrepTask, getPrepTask, readPrepCheckpoint, stopPrepTask } from "../src/prep/task-store.js";
import { executePrepUnits } from "../src/prep/executor.js";
import { splitSourceUnits } from "../src/prep/units.js";
let h: DbHandle;
let dir: string;
let taskId: string;
const schema = z.object({ text: z.string() });
const units = ["one", "two"].map((key) => ({ key, inputHash: key, reservedTokens: 10 }));
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "elenchi-executor-")); h = createDb(dir, { migrate: true });
  taskId = ensurePrepTask(h.db, { chunkId: "c", inputHash: "h", rulesVersion: "1", budget: { maxCalls: 10, maxTokens: 100, maxDurationMs: 10000, maxRepairs: 1 } }).id;
});
afterEach(() => { h.close(); rmSync(dir, { recursive: true, force: true }); });
describe("prep work execution", () => {
  it("resumes at the failed unit without spending again on verified work", async () => {
    const runUnit = vi.fn().mockResolvedValueOnce({ text: "first" }).mockRejectedValueOnce(new Error("offline"));
    expect((await executePrepUnits({ db: h.db, taskId, units, schema, runUnit })).completed).toBe(false);
    expect(getPrepTask(h.db, taskId)?.status).toBe("paused");
    resumePrepTask(h.db, taskId);
    const retry = vi.fn().mockResolvedValue({ text: "second" });
    const result = await executePrepUnits({ db: h.db, taskId, units, schema, runUnit: retry });
    expect(result).toEqual({ completed: true, outputs: [{ text: "first" }, { text: "second" }] });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(getPrepTask(h.db, taskId)?.callsUsed).toBe(3);
  });
  it("rejects a late result after task cancellation", async () => {
    const runUnit = vi.fn(async () => {
      stopPrepTask(h.db, taskId, "cancelled", "user");
      return { text: "late" };
    });
    expect((await executePrepUnits({ db: h.db, taskId, units, schema, runUnit })).completed).toBe(false);
    expect(readPrepCheckpoint(h.db, taskId, "one", "one", schema)).toBeUndefined();
    expect(getPrepTask(h.db, taskId)?.status).toBe("cancelled");
  });
  it("does not invoke model when already aborted", async () => {
    const controller = new AbortController(); controller.abort();
    const runUnit = vi.fn();
    await executePrepUnits({ db: h.db, taskId, units, schema, runUnit, signal: controller.signal });
    expect(runUnit).not.toHaveBeenCalled();
    expect(getPrepTask(h.db, taskId)?.callsUsed).toBe(0);
  });
  it("does not checkpoint invalid output", async () => {
    const result = await executePrepUnits({ db: h.db, taskId, units, schema, runUnit: async () => ({ text: 1 } as unknown as { text: string }) });
    expect(result.completed).toBe(false);
    expect(readPrepCheckpoint(h.db, taskId, "one", "one", schema)).toBeUndefined();
  });
});
describe("bounded source units", () => {
  it("preserves long source exactly, including formulas and surrogate pairs", () => {
    const source = "# 标题\n" + "😀`2*3` snake_case\n".repeat(100);
    const result = splitSourceUnits(source, 31);
    expect(result.map((u) => u.content).join("")).toBe(source);
    for (const unit of result) {
      expect(unit.content.length).toBeLessThanOrEqual(31);
      expect(source.slice(unit.start, unit.end)).toBe(unit.content);
      expect(/[\uD800-\uDBFF]$/.test(unit.content)).toBe(false);
    }
  });
  it("bounds a single paragraph without headings and handles empty sources", () => {
    expect(splitSourceUnits("a".repeat(1000), 100)).toHaveLength(10);
    expect(splitSourceUnits("", 100)).toEqual([]);
    expect(() => splitSourceUnits("x", 1)).toThrow();
  });
});
