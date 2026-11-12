import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type DbHandle } from "../src/db/client.js";
import { sessionTurns } from "../src/db/schema.js";
import { assistanceFromPreviousAction } from "../src/pedagogy/store.js";
let h: DbHandle; let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "elenchi-assistance-")); h = createDb(dir, { migrate: true }); });
afterEach(() => { h.close(); rmSync(dir, { recursive: true, force: true }); });
const assessment = JSON.stringify({});
const action = (actionType: string) => JSON.stringify({ actionType, hintLevel: 0, focus: null, targetKpId: null, evidenceQuotes: [], misconceptionTargets: [] });
describe("task attempt assistance source", () => {
  it("derives hint and explanation only from the latest server-owned action", () => {
    expect(assistanceFromPreviousAction(h.db, "s")).toBe("none");
    h.db.insert(sessionTurns).values({ id: "a", sessionId: "s", userMessageId: "u", assistantMessageId: "a", assessment, action: action("hint"), createdAt: new Date(1) }).run();
    expect(assistanceFromPreviousAction(h.db, "s")).toBe("hint");
    h.db.insert(sessionTurns).values({ id: "b", sessionId: "s", userMessageId: "u2", assistantMessageId: "a2", assessment, action: action("explain"), createdAt: new Date(1001) }).run();
    expect(assistanceFromPreviousAction(h.db, "s")).toBe("explanation");
  });
  it("does not classify other action types as assisted", () => {
    h.db.insert(sessionTurns).values({ id: "a", sessionId: "s", userMessageId: "u", assistantMessageId: "a", assessment, action: action("probe_evidence"), createdAt: new Date() }).run();
    expect(assistanceFromPreviousAction(h.db, "s")).toBe("none");
  });
});
