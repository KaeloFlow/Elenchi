import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { ensurePrepTask, claimPrepTask, getPrepTask } from "../src/prep/task-store.js";
import { reviewTeachingCard, teachingCardHash } from "../src/prep/review.js";
import type { TeachingCard } from "@elenchi/shared";
let h: DbHandle; let dir: string; let taskId: string;
const source = "教材依据和适用条件";
const card: TeachingCard = { version: "v", lessonId: "l", sourceHash: "", learnerVersion: "learner", rulesVersion: "r", objective: "目标",
  knowledge: [{ id: "k", statement: "命题", type: "concept", evidence: [source], conditions: ["适用条件"], exceptions: [] }],
  requirements: [{ id: "req", kpId: "k", kind: "boundary", criterion: "判断条件", independent: true }],
  tasks: [{ id: "t", requirementIds: ["req"], question: "何时适用", rubric: "指出条件", acceptableVariants: [], hints: [] }] };
const fetchMock = vi.fn();
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "elenchi-review-")); h = createDb(dir, { migrate: true }); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
  const task = ensurePrepTask(h.db, { chunkId: "c", inputHash: "h", rulesVersion: "r", budget: { maxCalls: 5, maxTokens: 50000, maxDurationMs: 10000, maxRepairs: 1 } }); taskId = task.id; claimPrepTask(h.db, taskId); });
afterEach(() => { vi.unstubAllGlobals(); h.close(); rmSync(dir, { recursive: true, force: true }); });
const sourceHash = () => createHash("sha256").update(source).digest("hex");
function opts() { return { db: h.db, taskId, generation: 1, card: { ...card, sourceHash: sourceHash() }, source, reviewContext: "仅发送的证据片段", baseUrl: "http://x", apiKey: "k", model: "m", signal: new AbortController().signal, contextTokens: 50000, maxOutputTokens: 1000 }; }
describe("semantic card review", () => {
  it("passes only when every check is true and issue quotes are grounded", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ checks: { supportedClaims: true, conditionsPreserved: true, coreCoverage: true, validAssessment: true }, issues: [] }) } }] })));
    const result = await reviewTeachingCard(opts());
    expect(result.status).toBe("passed");
    expect(await reviewTeachingCard(opts())).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const reviewInput = JSON.parse(request.messages[1].content);
    expect(reviewInput.sourceEvidence).toBe("仅发送的证据片段");
  });
  it("reuses a validated gap result without repurchasing the review", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ checks: { supportedClaims: true, conditionsPreserved: false, coreCoverage: true, validAssessment: true }, issues: [{ description: "缺少条件", sourceQuote: "适用条件" }] }) } }] })));
    const result = await reviewTeachingCard(opts());
    expect(result.status).toBe("gaps");
    expect(await reviewTeachingCard(opts())).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getPrepTask(h.db, taskId)?.status).toBe("running");
  });
  it("marks fabricated issue quotes unavailable", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ checks: { supportedClaims: true, conditionsPreserved: true, coreCoverage: true, validAssessment: true }, issues: [{ description: "问题", sourceQuote: "伪造" }] }) } }] })));
    expect((await reviewTeachingCard(opts())).status).toBe("unavailable");
  });
});
