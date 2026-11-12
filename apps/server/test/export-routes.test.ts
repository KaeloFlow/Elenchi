import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { startServer, type StartedServer } from "../src/server.js";

const SAMPLE_MD = ["# 第一章 极限", "极限是微积分的基础概念。"].join("\n");

/**
 * Two-protocol fake LLM (pipeline contract): the assessment call
 * (stream:false) gets a JSON reply, the generation call (stream:true) gets
 * an SSE stream with the given reply.
 */
function startFakeSseServer(
  reply: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const VALID_ASSESSMENT = JSON.stringify({
    correctness: "partially_correct",
    completeness: "partial",
    reasoningQuality: "weak",
    misconceptions: [],
    userSignals: [],
    evidenceQuotes: ["极限是微积分的基础概念。"],
    coveredKpIds: [],
    focus: null,
  });
  return new Promise((resolve) => {
    let assessmentCalls = 0;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let parsed: { stream?: boolean } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          /* keep default */
        }
        if (parsed.stream === false) {
          void assessmentCalls;
          assessmentCalls += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: VALID_ASSESSMENT } }],
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const ch of reply) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`,
          );
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("export routes", () => {
  let server: StartedServer | undefined;
  let tmpDir: string;
  let fakeLlm: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await server?.close();
    await fakeLlm?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startWithMigratedDb(): Promise<StartedServer> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-export-route-"));
    // startServer applies Drizzle migrations automatically; no extra exec needed.
    return startServer({ dataDir: tmpDir, port: 0 });
  }

  async function createSessionForSampleMaterial(baseUrl: string): Promise<string> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([SAMPLE_MD], { type: "text/markdown" }),
      "calc.md",
    );
    const matRes = await fetch(`${baseUrl}/api/materials`, {
      method: "POST",
      body: form,
    });
    const { id: materialId } = await matRes.json();
    const chunksRes = await fetch(`${baseUrl}/api/materials/${materialId}/chunks`);
    const [chunk] = await chunksRes.json();

    // v3: seed a lesson-anchored session directly (export tests don't
    // exercise teaching).
    const Database = (await import("better-sqlite3")).default;
    const sqlite = new Database(path.join(tmpDir, "elenchi.sqlite3"));
    const kpId = crypto.randomUUID();
    const lessonId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO knowledge_points (id, material_id, chunk_id, "order", statement, type, section_index, section_title, evidence, created_at)
         VALUES (?, ?, ?, 1, 'KP', 'fact', 0, 's', '[]', ?)`,
      )
      .run(kpId, materialId, chunk.id, now);
    sqlite
      .prepare(
        `INSERT INTO lessons (id, material_id, chunk_id, "order", title, objective, kp_ids, auto_packed, status, created_at)
         VALUES (?, ?, ?, 1, '第 1 课', '目标', ?, 0, 'active', ?)`,
      )
      .run(lessonId, materialId, chunk.id, JSON.stringify([kpId]), now);
    sqlite
      .prepare(
        `INSERT INTO sessions (id, material_id, chunk_id, lesson_id, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, materialId, chunk.id, lessonId, now);
    sqlite.close();
    return sessionId;
  }

  it("returns 404 for an unknown session", async () => {
    server = await startWithMigratedDb();

    const res = await fetch(`${server.url}/api/sessions/does-not-exist/export.md`);

    expect(res.status).toBe(404);
  });

  it("exports a transcript with no messages showing the placeholder", async () => {
    server = await startWithMigratedDb();
    const sessionId = await createSessionForSampleMaterial(server.url);

    const res = await fetch(`${server.url}/api/sessions/${sessionId}/export.md`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(`transcript-${sessionId}.md`);
    expect(text).toContain("还没有任何对话记录");
    expect(text).toContain("第一章 极限");
  });

  it("exports a transcript including real dialogue history in order", async () => {
    server = await startWithMigratedDb();
    fakeLlm = await startFakeSseServer("先别急。⅓ × 3 等于多少？");
    await fetch(`${server.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: fakeLlm.url, apiKey: "sk-test", model: "test-model" }),
    });

    const sessionId = await createSessionForSampleMaterial(server.url);
    await fetch(`${server.url}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "0.999... 不可能等于 1 吧" }),
    });

    const res = await fetch(`${server.url}/api/sessions/${sessionId}/export.md`);
    const text = await res.text();

    expect(res.status).toBe(200);
    const userIndex = text.indexOf("0.999... 不可能等于 1 吧");
    const assistantIndex = text.indexOf("先别急。⅓ × 3 等于多少？");
    expect(userIndex).toBeGreaterThan(-1);
    expect(assistantIndex).toBeGreaterThan(userIndex);
  });
});
