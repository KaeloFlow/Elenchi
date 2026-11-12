import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type DbHandle } from "../src/db/client.js";
import { misconceptionRecords } from "../src/db/schema.js";
import { applyMisconceptionLifecycle, listMisconceptionRecords } from "../src/pedagogy/misconception-store.js";
let h: DbHandle; let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "elenchi-misconception-store-")); h = createDb(dir, { migrate: true }); });
afterEach(() => { h.close(); rmSync(dir, { recursive: true, force: true }); });
describe("structured misconception store", () => {
  it("persists active diagnosis and evidence-linked uncertainty", () => {
    h.db.transaction((tx) => { applyMisconceptionLifecycle(tx, { sessionId: "s", materialId: "m", targetKpId: "k", diagnosed: ["混淆条件"], evidenceSatisfiedKpIds: [], evidenceMessageId: "u1" }); });
    expect(listMisconceptionRecords(h.db, "m")[0]).toMatchObject({ label: "混淆条件", kpId: "k", status: "active", evidenceMessageIds: ["u1"] });
    h.db.transaction((tx) => { applyMisconceptionLifecycle(tx, { sessionId: "s", materialId: "m", targetKpId: "k", diagnosed: [], evidenceSatisfiedKpIds: ["k"], evidenceMessageId: "u2" }); });
    expect(listMisconceptionRecords(h.db, "m")[0]).toMatchObject({ status: "uncertain", evidenceMessageIds: ["u1", "u2"] });
  });
  it("keeps diagnosis identity scoped by session", () => {
    h.db.transaction((tx) => { applyMisconceptionLifecycle(tx, { sessionId: "s1", materialId: "m", targetKpId: "k", diagnosed: ["误解"], evidenceSatisfiedKpIds: [], evidenceMessageId: "u1" }); applyMisconceptionLifecycle(tx, { sessionId: "s2", materialId: "m", targetKpId: "k", diagnosed: ["误解"], evidenceSatisfiedKpIds: [], evidenceMessageId: "u2" }); });
    expect(h.db.select().from(misconceptionRecords).all()).toHaveLength(2);
  });
});
