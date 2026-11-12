import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type DbHandle } from "../src/db/client.js";
import { lessons, materialChunks, lessonCardVersions } from "../src/db/schema.js";
import { insertSessionWithOpening } from "../src/dialogue/store.js";
import { getSession } from "../src/dialogue/store.js";
import { sourceFingerprint } from "../src/prep/publication.js";
let h: DbHandle; let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "elenchi-card-bind-")); h = createDb(dir, { migrate: true }); const now = new Date(); h.db.insert(materialChunks).values({ id: "c", materialId: "m", order: 1, title: "章", level: 1, content: "原文" }).run(); h.db.insert(lessons).values({ id: "l", materialId: "m", chunkId: "c", order: 1, title: "课", objective: "目标", kpIds: "[]", createdAt: now }).run(); });
afterEach(() => { h.close(); rmSync(dir, { recursive: true, force: true }); });
describe("session card binding", () => {
  it("binds the latest immutable published card at creation and preserves it", () => {
    const payload = JSON.stringify({ version: "v1", lessonId: "l", sourceHash: sourceFingerprint("原文"), learnerVersion: sourceFingerprint("null"), rulesVersion: "r", objective: "目标", knowledge: [{ id: "k", statement: "命题", type: "concept", evidence: ["原文"], conditions: [], exceptions: [] }], requirements: [{ id: "r", kpId: "k", kind: "boundary", criterion: "边界", independent: true }], tasks: [{ id: "t", requirementIds: ["r"], question: "问题", rubric: "边界", acceptableVariants: [], hints: [] }] });
    h.db.insert(lessonCardVersions).values({ version: "v1", lessonId: "l", taskId: "t", sourceHash: sourceFingerprint("原文"), learnerVersion: sourceFingerprint("null"), rulesVersion: "r", payload, publishedAt: new Date(1) }).run();
    const lesson = h.db.select().from(lessons).all()[0]!;
    const session = insertSessionWithOpening(h.db, lesson, "开场");
    h.db.insert(lessonCardVersions).values({ version: "v2", lessonId: "l", taskId: "t", sourceHash: sourceFingerprint("原文"), learnerVersion: sourceFingerprint("null"), rulesVersion: "r", payload: payload.replaceAll("v1", "v2"), publishedAt: new Date(2) }).run();
    expect(session.cardVersion).toBe("v1");
    expect(getSession(h.db, session.id)?.cardVersion).toBe("v1");
  });
  it("leaves legacy/unpublished lessons unbound", () => {
    const lesson = h.db.select().from(lessons).all()[0]!;
    expect(insertSessionWithOpening(h.db, lesson, "开场").cardVersion).toBeNull();
  });
});
