import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { TeachingCard } from "@elenchi/shared";
import { createDb, type DbHandle } from "../src/db/client.js";
import { lessons, materialChunks, sessions, materialProgress } from "../src/db/schema.js";
import { CardReviewSchema, teachingCardHash } from "../src/prep/review.js";
import { claimPrepTask, ensurePrepTask, stopPrepTask, savePrepCheckpoint } from "../src/prep/task-store.js";
import { publishTeachingCard, readPublishedCard, bindSessionCard, sourceFingerprint, learnerFingerprint } from "../src/prep/publication.js";
let dir: string;
let h: DbHandle;
let card: TeachingCard;
let taskId: string;
const now = new Date(1000);
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "elenchi-publication-")); h = createDb(dir, { migrate: true });
  h.db.insert(materialChunks).values({ id: "c", materialId: "m", order: 1, title: "章", level: 1, content: "教材依据" }).run();
  h.db.insert(lessons).values({ id: "l", materialId: "m", chunkId: "c", order: 1, title: "课", objective: "目标", kpIds: '["k"]', createdAt: now }).run();
  h.db.insert(sessions).values({ id: "s", materialId: "m", chunkId: "c", lessonId: "l", startedAt: now }).run();
  const task = ensurePrepTask(h.db, { chunkId: "c", inputHash: "input", rulesVersion: "r", budget: { maxCalls: 10, maxTokens: 1000, maxDurationMs: 1000, maxRepairs: 1 } }, now);
  taskId = task.id; claimPrepTask(h.db, taskId, now);
  card = { version: "v", lessonId: "l", sourceHash: sourceFingerprint("教材依据"), learnerVersion: learnerFingerprint(h.db, "m"), rulesVersion: "r", objective: "目标",
    knowledge: [{ id: "k", statement: "命题", type: "concept", evidence: ["教材依据"], conditions: [], exceptions: [] }],
    requirements: [{ id: "req", kpId: "k", kind: "boundary", criterion: "判断边界", independent: true }],
    tasks: [{ id: "t", requirementIds: ["req"], question: "适用吗", rubric: "依据条件", acceptableVariants: [], hints: [] }] };
});
afterEach(() => { h.close(); rmSync(dir, { recursive: true, force: true }); });
function approve(candidate: TeachingCard) {
  const hash = teachingCardHash(candidate);
  savePrepCheckpoint(h.db, { taskId, generation: 1, unitKey: `semantic-review:${candidate.version}`, inputHash: hash,
    payload: { cardHash: hash, sourceHash: candidate.sourceHash, status: "passed" as const,
      checks: { supportedClaims: true, conditionsPreserved: true, coreCoverage: true, validAssessment: true }, issues: [] } }, CardReviewSchema, now);
}
describe("immutable lesson publication", () => {
  it("publishes idempotently but cannot overwrite a snapshot or rebind a session", () => {
    approve(card);
    expect(publishTeachingCard(h.db, taskId, 1, card, now)).toBe(true);
    expect(publishTeachingCard(h.db, taskId, 1, card, now)).toBe(true);
    expect(publishTeachingCard(h.db, taskId, 1, { ...card, objective: "被改写" }, now)).toBe(false);
    expect(readPublishedCard(h.db, "v")?.objective).toBe("目标");
    expect(bindSessionCard(h.db, "s", "v")).toBe(true);
    approve({ ...card, version: "v2" });
    expect(publishTeachingCard(h.db, taskId, 1, { ...card, version: "v2" }, now)).toBe(true);
    expect(bindSessionCard(h.db, "s", "v2")).toBe(false);
  });
  it("requires a passing review bound to the exact payload", () => {
    expect(publishTeachingCard(h.db, taskId, 1, card, now)).toBe(false);
    approve(card);
    expect(publishTeachingCard(h.db, taskId, 1, { ...card, objective: "changed" }, now)).toBe(false);
  });
  it("rejects changed source and changed learner snapshot", () => {
    approve(card);
    h.db.update(materialChunks).set({ content: "已变更" }).where(eq(materialChunks.id, "c")).run();
    expect(publishTeachingCard(h.db, taskId, 1, card, now)).toBe(false);
    h.db.update(materialChunks).set({ content: "教材依据" }).where(eq(materialChunks.id, "c")).run();
    h.db.insert(materialProgress).values({ materialId: "m", masteredKpIds: '["previous"]', updatedAt: now }).run();
    expect(publishTeachingCard(h.db, taskId, 1, card, now)).toBe(false);
  });
  it("rejects wrong generation, expired lease, and cancellation", () => {
    expect(publishTeachingCard(h.db, taskId, 0, card, now)).toBe(false);
    expect(publishTeachingCard(h.db, taskId, 1, card, new Date(2000))).toBe(false);
    stopPrepTask(h.db, taskId, "cancelled", "user", now);
    expect(publishTeachingCard(h.db, taskId, 1, card, now)).toBe(false);
  });
  it("rejects ungrounded source evidence", () => {
    card.knowledge[0]!.evidence = ["不存在"];
    expect(publishTeachingCard(h.db, taskId, 1, card, now)).toBe(false);
  });
});
