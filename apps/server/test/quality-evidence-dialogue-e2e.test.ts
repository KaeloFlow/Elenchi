import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createDb, type DbHandle } from "../src/db/client.js";
import { lessonCardVersions, lessons, knowledgePoints, materialChunks, sessions, materials, taskAttempts, learningEvidence, sessionPedagogyState, materialProgress } from "../src/db/schema.js";
import { sourceFingerprint } from "../src/prep/publication.js";
import { writeSettings } from "../src/settings/store.js";
import { startServer, type StartedServer } from "../src/server.js";
let dir: string; let h: DbHandle; let server: StartedServer; let llm: http.Server;
const source = "概念只有在条件成立时适用。";
const card = { version: "v", lessonId: "l", sourceHash: sourceFingerprint(source), learnerVersion: sourceFingerprint("null"), rulesVersion: "r", objective: "能说明条件", knowledge: [{ id: "k", statement: "概念有适用条件", type: "concept" as const, evidence: ["概念只有在条件成立时适用。"], conditions: ["条件成立"], exceptions: [] }], requirements: [{ id: "r", kpId: "k", kind: "boundary" as const, criterion: "指出适用条件", independent: true }], tasks: [{ id: "t", requirementIds: ["r"], question: "条件是什么？", rubric: "指出条件", acceptableVariants: [], hints: [] }] };
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "elenchi-quality-e2e-")); h = createDb(dir, { migrate: true }); const now = new Date();
  h.db.insert(materials).values({ id: "m", title: "教材", sourcePath: "x", createdAt: now }).run(); h.db.insert(materialChunks).values({ id: "c", materialId: "m", order: 1, title: "章", level: 1, content: source }).run();
  h.db.insert(knowledgePoints).values({ id: "k", materialId: "m", chunkId: "c", order: 1, statement: "概念有适用条件", type: "concept", sectionIndex: 0, sectionTitle: "章", evidence: JSON.stringify([source]), createdAt: now }).run();
  h.db.insert(lessons).values({ id: "l", materialId: "m", chunkId: "c", order: 1, title: "课", objective: "目标", kpIds: '["k"]', createdAt: now }).run();
  h.db.insert(lessonCardVersions).values({ version: "v", lessonId: "l", taskId: "p", sourceHash: card.sourceHash, learnerVersion: card.learnerVersion, rulesVersion: "r", payload: JSON.stringify(card), publishedAt: now }).run();
  h.db.insert(sessions).values({ id: "s", materialId: "m", chunkId: "c", lessonId: "l", cardVersion: "v", startedAt: now }).run(); h.close();
  let calls = 0; llm = http.createServer((req, res) => { let body = ""; req.on("data", (chunk) => body += chunk); req.on("end", () => { const request = JSON.parse(body) as { stream?: boolean }; if (request.stream !== false) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "继续思考条件。" } }] })}\n\ndata: [DONE]\n\n`); return; } calls++; const assessment = { correctness: "correct", completeness: "complete", reasoningQuality: "sound", misconceptions: [], userSignals: [], evidenceQuotes: [source], coveredKpIds: ["k"], evidence: [{ taskId: "t", requirementId: "r", answerQuote: "条件成立", verdict: "satisfied", rationale: "指出条件" }], focus: "条件" }; res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(assessment) } }] })); }); }); await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve)); const port = (llm.address() as { port: number }).port; writeSettings(dir, { baseUrl: `http://127.0.0.1:${port}`, apiKey: "x", model: "m" }); server = await startServer({ dataDir: dir, port: 0 });
});
afterEach(async () => { await server?.close(); await new Promise<void>((resolve) => llm?.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
describe("quality card evidence dialogue route", () => {
  it("persists a server-bound attempt and grounded evidence, then updates mastery", async () => {
    const before = await (await fetch(`${server.url}/api/sessions/s/evidence-progress`)).json();
    expect(before).toEqual({ sessionId: "s", cardVersion: "v", totalRequirementCount: 1, satisfiedRequirementCount: 0, uncertainRequirementCount: 0, notSatisfiedRequirementCount: 0 });
    const response = await fetch(`${server.url}/api/sessions/s/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "因为条件成立，所以适用。" }) });
    expect(response.status).toBe(200); expect(await response.text()).toContain("done");
    h = createDb(dir, { migrate: true });
    expect(h.db.select().from(taskAttempts).all()).toHaveLength(1); expect(h.db.select().from(learningEvidence).all()).toHaveLength(1);
    expect(JSON.parse(h.db.select().from(sessionPedagogyState).all()[0]!.coveredPoints)).toEqual(["k"]);
    expect(JSON.parse(h.db.select().from(materialProgress).all()[0]!.masteredKpIds)).toEqual(["k"]); h.close();
    const after = await (await fetch(`${server.url}/api/sessions/s/evidence-progress`)).json();
    expect(after).toEqual({ sessionId: "s", cardVersion: "v", totalRequirementCount: 1, satisfiedRequirementCount: 1, uncertainRequirementCount: 0, notSatisfiedRequirementCount: 0 });
  });
});
