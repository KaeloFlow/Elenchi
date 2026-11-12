import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { prepareKnowledgeUnits } from "../src/prep/knowledge-preparation.js";
import { getPrepTask, resumePrepTask } from "../src/prep/task-store.js";
let h: DbHandle;
let dir: string;
const fetchMock = vi.fn();
const point = { statement: "定义", type: "concept", evidence: ["原文"], conditions: [], exceptions: [] };
const response = (body: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }));
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "elenchi-knowledge-")); h = createDb(dir, { migrate: true }); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); h.close(); rmSync(dir, { recursive: true, force: true }); });
function options() { return { db: h.db, chunkId: "c", source: "原文", baseUrl: "http://fake", apiKey: "k", model: "m", budget: { maxCalls: 10, maxTokens: 50000, maxDurationMs: 10000, maxRepairs: 1 }, maxChars: 100, contextTokens: 10000, maxOutputTokens: 1000 }; }
describe("checkpointed knowledge preparation", () => {
  it("persists validated results and reuses completed work without HTTP", async () => {
    fetchMock.mockResolvedValueOnce(response({ points: [point] }));
    const first = await prepareKnowledgeUnits(options());
    expect(first.completed).toBe(true);
    expect(first.outputs[0]?.sourceStart).toBe(0);
    const second = await prepareKnowledgeUnits(options());
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("charges each corrective call and rejects invented evidence", async () => {
    fetchMock.mockResolvedValueOnce(response({ points: [{ ...point, evidence: ["虚构"] }] }))
      .mockResolvedValueOnce(response({ points: [point] }));
    const result = await prepareKnowledgeUnits(options());
    expect(result.completed).toBe(true);
    expect(getPrepTask(h.db, result.taskId)?.callsUsed).toBe(2);
  });
  it("resumes after HTTP failure without repeating a successful source unit", async () => {
    fetchMock.mockResolvedValueOnce(response({ points: [point] }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }));
    const input = { ...options(), source: "原文原文", maxChars: 2 };
    const first = await prepareKnowledgeUnits(input);
    expect(first.completed).toBe(false);
    expect(first.outputs).toHaveLength(1);
    resumePrepTask(h.db, first.taskId);
    fetchMock.mockResolvedValueOnce(response({ points: [point] }));
    const second = await prepareKnowledgeUnits(input);
    expect(second.completed).toBe(true);
    expect(second.outputs).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("never marks an invalid unit complete after the repair limit", async () => {
    fetchMock.mockImplementation(async () => response({ points: [{ ...point, type: "invented" }] }));
    const result = await prepareKnowledgeUnits(options());
    expect(result.completed).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getPrepTask(h.db, result.taskId)?.status).toBe("paused");
  });
});
