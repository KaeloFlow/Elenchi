import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDb, type DbHandle } from "../src/db/client.js";
import { ensurePrepTask, claimPrepTask, reservePrepCall, savePrepCheckpoint, readPrepCheckpoint,
  stopPrepTask, resumePrepTask, finishPrepTask, recoverInterruptedPrepTasks, getPrepTask } from "../src/prep/task-store.js";

let dir: string;
let handle: DbHandle;
const now = new Date(1000);
const identity = { chunkId: "c", inputHash: "h", rulesVersion: "1",
  budget: { maxCalls: 2, maxTokens: 100, maxDurationMs: 1000, maxRepairs: 1 } };
const payloadSchema = z.object({ verified: z.boolean() }).strict();
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "elenchi-task-")); handle = createDb(dir, { migrate: true }); });
afterEach(() => { handle.close(); rmSync(dir, { recursive: true, force: true }); });
describe("prep task ownership and budget", () => {
  it("reuses identity without resetting state, separates changed inputs, and claims once", () => {
    const task = ensurePrepTask(handle.db, identity, now);
    expect(ensurePrepTask(handle.db, identity, now).id).toBe(task.id);
    expect(ensurePrepTask(handle.db, { ...identity, inputHash: "changed" }, now).id).not.toBe(task.id);
    expect(claimPrepTask(handle.db, task.id, now)?.generation).toBe(1);
    expect(claimPrepTask(handle.db, task.id, now)).toBeUndefined();
    expect(ensurePrepTask(handle.db, identity, now).status).toBe("running");
  });
  it("reserves budget atomically and invalidates late writes when exhausted", () => {
    const task = claimPrepTask(handle.db, ensurePrepTask(handle.db, identity, now).id, now)!;
    expect(reservePrepCall(handle.db, task.id, task.generation, 60, now)).toBe(true);
    expect(reservePrepCall(handle.db, task.id, task.generation, 41, now)).toBe(false);
    expect(getPrepTask(handle.db, task.id)?.tokensUsed).toBe(60);
    expect(getPrepTask(handle.db, task.id)?.reason).toBe("budget_exhausted");
    expect(finishPrepTask(handle.db, task.id, task.generation, now)).toBe(false);
  });
  it("retains checkpoints across recovery and fences the old executor", () => {
    const task = claimPrepTask(handle.db, ensurePrepTask(handle.db, identity, now).id, now)!;
    const cp = { taskId: task.id, generation: task.generation, unitKey: "u", inputHash: "v", payload: { verified: true } };
    expect(savePrepCheckpoint(handle.db, cp, payloadSchema, now)).toBe(true);
    expect(recoverInterruptedPrepTasks(handle.db, now)).toBe(1);
    expect(savePrepCheckpoint(handle.db, { ...cp, unitKey: "late" }, payloadSchema, now)).toBe(false);
    resumePrepTask(handle.db, task.id, now);
    const next = claimPrepTask(handle.db, task.id, now)!;
    expect(next.generation).toBeGreaterThan(task.generation);
    expect(readPrepCheckpoint(handle.db, task.id, "u", "v", payloadSchema)).toEqual({ verified: true });
    expect(readPrepCheckpoint(handle.db, task.id, "u", "changed", payloadSchema)).toBeUndefined();
    expect(finishPrepTask(handle.db, task.id, task.generation, now)).toBe(false);
    expect(finishPrepTask(handle.db, task.id, next.generation, now)).toBe(true);
  });
  it("rejects writes after deadline and after cancellation", () => {
    const task = claimPrepTask(handle.db, ensurePrepTask(handle.db, identity, now).id, now)!;
    expect(reservePrepCall(handle.db, task.id, task.generation, 1, new Date(2000))).toBe(false);
    stopPrepTask(handle.db, task.id, "cancelled", "user", now);
    expect(resumePrepTask(handle.db, task.id, now)).toBeUndefined();
    expect(finishPrepTask(handle.db, task.id, task.generation, now)).toBe(false);
  });
  it("rejects invalid configuration before persistence", () => {
    expect(() => ensurePrepTask(handle.db, { ...identity, budget: { ...identity.budget, maxCalls: Infinity } }, now)).toThrow();
  });
  it("enforces the call limit even for zero token reservations", () => {
    const task = claimPrepTask(handle.db, ensurePrepTask(handle.db, identity, now).id, now)!;
    expect(reservePrepCall(handle.db, task.id, task.generation, 0, now)).toBe(true);
    expect(reservePrepCall(handle.db, task.id, task.generation, 0, now)).toBe(true);
    expect(reservePrepCall(handle.db, task.id, task.generation, 0, now)).toBe(false);
  });
});
