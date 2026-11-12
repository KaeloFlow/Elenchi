import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type DbHandle } from "../src/db/client.js";
import { lessonCardVersions } from "../src/db/schema.js";
import { recordTaskAttempt, readTaskAttempts } from "../src/pedagogy/task-attempt-store.js";
import { sourceFingerprint } from "../src/prep/publication.js";
let h: DbHandle; let dir: string;
const payload = JSON.stringify({ version: "v", lessonId: "l", sourceHash: sourceFingerprint("原文"), learnerVersion: "p", rulesVersion: "r", objective: "目标", knowledge: [{ id: "k", statement: "命题", type: "concept", evidence: ["原文"], conditions: [], exceptions: [] }], requirements: [{ id: "req", kpId: "k", kind: "boundary", criterion: "边界", independent: true }], tasks: [{ id: "task", requirementIds: ["req"], question: "问题", rubric: "边界", acceptableVariants: [], hints: [] }] });
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "elenchi-task-attempt-")); h = createDb(dir, { migrate: true }); h.db.insert(lessonCardVersions).values({ version: "v", lessonId: "l", taskId: "prep", sourceHash: sourceFingerprint("原文"), learnerVersion: "p", rulesVersion: "r", payload, publishedAt: new Date() }).run(); });
afterEach(() => { h.close(); rmSync(dir, { recursive: true, force: true }); });
describe("server task attempt store", () => {
  it("records only a task that belongs to a published immutable card", () => {
    let saved = false;
    h.db.transaction((tx) => { saved = recordTaskAttempt(tx, { sessionId: "s", cardVersion: "v", taskId: "task", userMessageId: "u", assistance: "none", observedPerformance: false }); });
    expect(saved).toBe(true);
    expect(readTaskAttempts(h.db, "s", new Map([["u", "学生回答"]]))).toEqual([{ cardVersion: "v", taskId: "task", userMessageId: "u", answer: "学生回答", assistance: "none", observedPerformance: false }]);
  });
  it("rejects an invented task before persistence", () => {
    let saved = true;
    h.db.transaction((tx) => { saved = recordTaskAttempt(tx, { sessionId: "s", cardVersion: "v", taskId: "invented", userMessageId: "u", assistance: "none", observedPerformance: false }); });
    expect(saved).toBe(false); expect(readTaskAttempts(h.db, "s", new Map())).toEqual([]);
  });
});
