import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type DbHandle } from "../src/db/client.js";
import { learningEvidence } from "../src/db/schema.js";
import { recordLearningEvidence, readLearningEvidence } from "../src/pedagogy/learning-evidence-store.js";
let h: DbHandle; let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "elenchi-learning-evidence-")); h = createDb(dir, { migrate: true }); });
afterEach(() => { h.close(); rmSync(dir, { recursive: true, force: true }); });
const evidence = { cardVersion: "v", taskId: "t", requirementId: "r", userMessageId: "u", answerQuote: "回答", verdict: "satisfied" as const, rationale: "理由", assessmentVersion: "quality-evidence-1" };
describe("learning evidence persistence", () => {
  it("stores a real-message-bound evidence verdict idempotently", () => {
    h.db.transaction((tx) => { recordLearningEvidence(tx, { sessionId: "s", ...evidence }); recordLearningEvidence(tx, { sessionId: "s", ...evidence }); });
    expect(readLearningEvidence(h.db, "s", "v")).toEqual([evidence]);
    expect(h.db.select().from(learningEvidence).all()).toHaveLength(1);
  });
  it("does not mix another card version into the current evidence set", () => {
    h.db.transaction((tx) => { recordLearningEvidence(tx, { sessionId: "s", ...evidence }); recordLearningEvidence(tx, { sessionId: "s", ...evidence, cardVersion: "old" }); });
    expect(readLearningEvidence(h.db, "s", "v")).toEqual([evidence]);
  });
});
