import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { ensurePrepTask, claimPrepTask, getPrepTask } from "../src/prep/task-store.js";
import { requestPrepCompletion } from "../src/prep/model-call.js";
let h: DbHandle;
let dir: string;
let taskId: string;
const mockFetch = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("fetch", mockFetch); mockFetch.mockReset();
  dir = mkdtempSync(path.join(tmpdir(), "elenchi-model-budget-")); h = createDb(dir, { migrate: true });
  taskId = ensurePrepTask(h.db, { chunkId: "c", inputHash: "h", rulesVersion: "1", budget: { maxCalls: 1, maxTokens: 10000, maxDurationMs: 60000, maxRepairs: 1 } }).id;
  claimPrepTask(h.db, taskId);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); h.close(); rmSync(dir, { recursive: true, force: true }); });
function options() { return { db: h.db, taskId, generation: 1, baseUrl: "http://fake", apiKey: "k", model: "m", messages: [{ role: "user" as const, content: "hello" }], signal: new AbortController().signal, contextTokens: 4000, maxOutputTokens: 100 }; }
describe("model transport preparation budget", () => {
  it("denies a retry before HTTP when the first attempt consumed the call budget", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));
    const promise = requestPrepCompletion(options());
    const assertion = expect(promise).rejects.toThrow("prep_call_budget_unavailable");
    await vi.runAllTimersAsync(); await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getPrepTask(h.db, taskId)?.callsUsed).toBe(1);
    expect(getPrepTask(h.db, taskId)?.status).toBe("paused");
  });
  it("does not retry an HTTP error after response headers", async () => {
    mockFetch.mockResolvedValue(new Response("provider failure", { status: 500 }));
    await expect(requestPrepCompletion(options())).rejects.toThrow("HTTP 500");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getPrepTask(h.db, taskId)?.callsUsed).toBe(1);
  });

  it("supplies output cap and counts a successful attempt", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    expect(await requestPrepCompletion(options())).toBe("ok");
    expect(JSON.parse(mockFetch.mock.calls[0]![1].body).max_tokens).toBe(100);
    expect(getPrepTask(h.db, taskId)?.callsUsed).toBe(1);
  });
  it("rejects oversized inputs and pre-aborted work before reservation", async () => {
    await expect(requestPrepCompletion({ ...options(), contextTokens: 10 })).rejects.toThrow("prep_context_budget_exceeded");
    const controller = new AbortController(); controller.abort();
    await expect(requestPrepCompletion({ ...options(), signal: controller.signal })).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(getPrepTask(h.db, taskId)?.callsUsed).toBe(0);
  });
});
