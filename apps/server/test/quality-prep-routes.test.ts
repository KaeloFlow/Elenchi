import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { startServer, type StartedServer } from "../src/server.js";
import { writeSettings } from "../src/settings/store.js";
import { createDb } from "../src/db/client.js";
import { materials, materialChunks } from "../src/db/schema.js";
import { upsertSettings } from "../src/settings/store.js";
let server: StartedServer; let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "elenchi-quality-routes-"));
  const h = createDb(dir, { migrate: true });
  const now = new Date();
  h.db.insert(materials).values({ id: "m", title: "教材", sourcePath: "x", createdAt: now }).run();
  h.db.insert(materialChunks).values({ id: "c", materialId: "m", order: 1, title: "章", level: 1, content: "原文" }).run();
  writeSettings(dir, { baseUrl: "http://fake", apiKey: "secret", model: "model" });
  h.close(); server = await startServer({ dataDir: dir, port: 0 });
});
afterEach(async () => { vi.unstubAllGlobals(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
const post = (url: string, body?: unknown) => fetch(`${server.url}${url}`, { method: "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
const eventually = async <T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> => {
  for (let i = 0; i < 30; i++) { const value = await read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("task_did_not_settle");
};
describe("quality prep task routes", () => {
  it("creates idempotent durable task and reports checkpoints without exposing secrets", async () => {
    const first = await post("/api/chunks/c/quality-prep", {});
    expect(first.status).toBe(202); const a = await first.json(); expect(a.status).toBe("queued");
    const second = await post("/api/chunks/c/quality-prep", {}); const b = await second.json();
    expect(b.taskId).toBe(a.taskId);
    const recovered = await fetch(`${server.url}/api/chunks/c/quality-prep/task`);
    expect(await recovered.json()).toMatchObject({ taskId: a.taskId, chunkId: "c", status: "queued", checkpointCount: 0 });
    const status = await fetch(`${server.url}/api/quality-prep/tasks/${a.taskId}`); const snapshot = await status.json();
    expect(snapshot).toMatchObject({ taskId: a.taskId, chunkId: "c", status: "queued", checkpointCount: 0 });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });
  it("starts an API-created task with the same identity and persists its final candidate", async () => {
    const realFetch = globalThis.fetch;
    let modelCalls = 0;
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => String(url).startsWith("http://fake")
      ? Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelCalls++ === 0
        ? { points: [{ statement: "命题", type: "concept", evidence: ["原文"], conditions: [], exceptions: [] }] }
        : { checks: { supportedClaims: true, conditionsPreserved: true, coreCoverage: true, validAssessment: true }, issues: [] }) } }] })))
      : realFetch(url, init));
    vi.stubGlobal("fetch", fetchMock);
    const created = await (await post("/api/chunks/c/quality-prep")).json();
    const start = await post(`/api/quality-prep/tasks/${created.taskId}/start`);
    expect(start.status).toBe(202);
    const status = await eventually(async () => (await fetch(`${server.url}/api/quality-prep/tasks/${created.taskId}`)).json(), (value) => value.status !== "queued" && value.status !== "running");
    expect(status).toMatchObject({ status: "succeeded", checkpointCount: 4 });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("http://fake"))).toHaveLength(2);
  });
  it("deduplicates concurrent explicit starts at the task claim fence", async () => {
    const realFetch = globalThis.fetch; let modelCalls = 0;
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => String(url).startsWith("http://fake")
      ? Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelCalls++ === 0 ? { points: [{ statement: "命题", type: "concept", evidence: ["原文"], conditions: [], exceptions: [] }] } : { checks: { supportedClaims: true, conditionsPreserved: true, coreCoverage: true, validAssessment: true }, issues: [] }) } }] })))
      : realFetch(url, init));
    vi.stubGlobal("fetch", fetchMock);
    const created = await (await post("/api/chunks/c/quality-prep")).json();
    const starts = await Promise.all([post(`/api/quality-prep/tasks/${created.taskId}/start`), post(`/api/quality-prep/tasks/${created.taskId}/start`)]);
    expect(starts.map((response) => response.status).sort()).toEqual([202, 409]);
    const final = await eventually(async () => (await fetch(`${server.url}/api/quality-prep/tasks/${created.taskId}`)).json(), (value) => value.status !== "queued" && value.status !== "running");
    expect(final.status).toBe("succeeded");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("http://fake"))).toHaveLength(2);
  });

  it("restarts an explicitly resumed paused task", async () => {
    const realFetch = globalThis.fetch; let modelCalls = 0;
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => String(url).startsWith("http://fake")
      ? Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelCalls++ === 0 ? { points: [{ statement: "命题", type: "concept", evidence: ["原文"], conditions: [], exceptions: [] }] } : { checks: { supportedClaims: true, conditionsPreserved: true, coreCoverage: true, validAssessment: true }, issues: [] }) } }] })))
      : realFetch(url, init));
    vi.stubGlobal("fetch", fetchMock);
    const created = await (await post("/api/chunks/c/quality-prep")).json();
    // Seed the durable paused state before any worker run, then exercise the same
    // explicit resume path the UI uses after an interrupted task.
    const db = new Database(path.join(dir, "elenchi.sqlite3")); db.prepare("UPDATE prep_tasks SET status = 'paused', reason = 'test_pause' WHERE id = ?").run(created.taskId); db.close();
    const resumed = await post(`/api/quality-prep/tasks/${created.taskId}/resume`); expect(resumed.status).toBe(200); expect((await resumed.json()).status).toBe("running");
    const final = await eventually(async () => (await fetch(`${server.url}/api/quality-prep/tasks/${created.taskId}`)).json(), (value) => value.status !== "queued" && value.status !== "running");
    expect(final.status).toBe("succeeded");
  });

  it("supports explicit cancellation and refuses resume after cancellation", async () => {
    const created = await (await post("/api/chunks/c/quality-prep")).json();
    expect((await (await post(`/api/quality-prep/tasks/${created.taskId}/cancel`)).json()).status).toBe("cancelled");
    expect((await post(`/api/quality-prep/tasks/${created.taskId}/resume`)).status).toBe(409);
    expect((await (await fetch(`${server.url}/api/chunks/c/quality-prep/task`)).json()).status).toBe("cancelled");
  });
  it("rejects unknown chunks and invalid options", async () => {
    expect((await post("/api/chunks/nope/quality-prep")).status).toBe(404);
    expect((await post("/api/chunks/c/quality-prep", { maxChars: 1 })).status).toBe(400);
    expect((await fetch(`${server.url}/api/quality-prep/tasks/nope`)).status).toBe(404);
  });
});
