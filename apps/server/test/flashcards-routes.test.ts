import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { startServer, type StartedServer } from "../src/server.js";

const SAMPLE_MD = ["# 第一章 极限", "极限是微积分的基础概念。"].join("\n");

function startFakeJsonLlmServer(
  reply: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }),
      );
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

describe("flashcards routes", () => {
  let server: StartedServer | undefined;
  let tmpDir: string;
  let fakeLlm: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await server?.close();
    await fakeLlm?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startWithMigratedDb(): Promise<StartedServer> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-flashcards-route-"));
    // startServer applies Drizzle migrations automatically; no extra exec needed.
    return startServer({ dataDir: tmpDir, port: 0 });
  }

  async function setupSessionWithHistory(baseUrl: string): Promise<string> {
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

    // v3: flashcards tests don't exercise teaching, so seed a session row
    // directly (anchored to a seeded lesson to stay on the supported path).
    const Database = (await import("better-sqlite3")).default;
    const dbPath = path.join(tmpDir, "elenchi.sqlite3");
    const sqlite = new Database(dbPath);
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

  async function configureFakeLlm(baseUrl: string, llmUrl: string): Promise<void> {
    await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: llmUrl, apiKey: "sk-test", model: "test-model" }),
    });
  }

  it("returns 400 when generating flashcards for a session with no messages", async () => {
    server = await startWithMigratedDb();
    fakeLlm = await startFakeJsonLlmServer(JSON.stringify({ flashcards: [] }));
    await configureFakeLlm(server.url, fakeLlm.url);
    const sessionId = await setupSessionWithHistory(server.url);

    const res = await fetch(
      `${server.url}/api/sessions/${sessionId}/flashcards/generate`,
      { method: "POST" },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("no_dialogue_history");
  });

  it("returns 404 for generating flashcards on an unknown session", async () => {
    server = await startWithMigratedDb();

    const res = await fetch(
      `${server.url}/api/sessions/does-not-exist/flashcards/generate`,
      { method: "POST" },
    );

    expect(res.status).toBe(404);
  });

  it("generates, persists, and lists flashcards from real dialogue history", async () => {
    server = await startWithMigratedDb();
    const sessionId = await setupSessionWithHistory(server.url);

    // Seed dialogue history via the real send-message SSE endpoint using a
    // separate fake SSE LLM, then switch settings to the JSON-mode fake LLM
    // for extraction (two different response shapes, so two fake servers).
    const sseLlm = await startFakeSseServerReply("先别急，⅓ × 3 等于多少？");
    await configureFakeLlm(server.url, sseLlm.url);
    await fetch(`${server.url}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "0.999... 不可能等于 1 吧" }),
    });
    await sseLlm.close();

    const extractedPayload = JSON.stringify({
      flashcards: [
        {
          question: "0.999... 等于多少？",
          options: ["0.999...", "1"],
          answer: "1",
          explanation: "⅓ × 3 = 1",
        },
      ],
    });
    fakeLlm = await startFakeJsonLlmServer(extractedPayload);
    await configureFakeLlm(server.url, fakeLlm.url);

    const genRes = await fetch(
      `${server.url}/api/sessions/${sessionId}/flashcards/generate`,
      { method: "POST" },
    );
    const genBody = await genRes.json();

    expect(genRes.status).toBe(200);
    expect(genBody.flashcards).toHaveLength(1);
    expect(genBody.flashcards[0].answer).toBe("1");

    const listRes = await fetch(`${server.url}/api/sessions/${sessionId}/flashcards`);
    const listBody = await listRes.json();
    expect(listBody).toHaveLength(1);
  });

  it("returns 404 when listing flashcards for an unknown session", async () => {
    server = await startWithMigratedDb();

    const res = await fetch(`${server.url}/api/sessions/does-not-exist/flashcards`);

    expect(res.status).toBe(404);
  });

  it("updates a flashcard's answer via PUT", async () => {
    server = await startWithMigratedDb();
    const sessionId = await setupSessionWithHistory(server.url);
    const sseLlm = await startFakeSseServerReply("回复内容");
    await configureFakeLlm(server.url, sseLlm.url);
    await fetch(`${server.url}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "问题" }),
    });
    await sseLlm.close();

    fakeLlm = await startFakeJsonLlmServer(
      JSON.stringify({
        flashcards: [{ question: "q1", answer: "a1" }],
      }),
    );
    await configureFakeLlm(server.url, fakeLlm.url);
    const genRes = await fetch(
      `${server.url}/api/sessions/${sessionId}/flashcards/generate`,
      { method: "POST" },
    );
    const { flashcards } = await genRes.json();
    const cardId = flashcards[0].id;

    const putRes = await fetch(`${server.url}/api/flashcards/${cardId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "a1-corrected" }),
    });
    const putBody = await putRes.json();

    expect(putRes.status).toBe(200);
    expect(putBody.answer).toBe("a1-corrected");
  });

  it("returns 400 instead of issuing an empty flashcard update", async () => {
    server = await startWithMigratedDb();
    const sessionId = await setupSessionWithHistory(server.url);
    const sseLlm = await startFakeSseServerReply("回复内容");
    await configureFakeLlm(server.url, sseLlm.url);
    await fetch(`${server.url}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "问题" }),
    });
    await sseLlm.close();
    fakeLlm = await startFakeJsonLlmServer(
      JSON.stringify({ flashcards: [{ question: "q1", answer: "a1" }] }),
    );
    await configureFakeLlm(server.url, fakeLlm.url);
    const generated = await fetch(
      `${server.url}/api/sessions/${sessionId}/flashcards/generate`,
      { method: "POST" },
    );
    const cardId = (await generated.json()).flashcards[0].id as string;

    const res = await fetch(`${server.url}/api/flashcards/${cardId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_input");
    const list = await fetch(`${server.url}/api/sessions/${sessionId}/flashcards`);
    expect((await list.json())[0]).toEqual(
      expect.objectContaining({ id: cardId, question: "q1", answer: "a1" }),
    );
  });

  it("returns 404 when updating an unknown flashcard", async () => {
    server = await startWithMigratedDb();

    const res = await fetch(`${server.url}/api/flashcards/does-not-exist`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "x" }),
    });

    expect(res.status).toBe(404);
  });

  it("deletes a flashcard", async () => {
    server = await startWithMigratedDb();
    const sessionId = await setupSessionWithHistory(server.url);
    const sseLlm = await startFakeSseServerReply("回复内容");
    await configureFakeLlm(server.url, sseLlm.url);
    await fetch(`${server.url}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "问题" }),
    });
    await sseLlm.close();

    fakeLlm = await startFakeJsonLlmServer(
      JSON.stringify({ flashcards: [{ question: "q1", answer: "a1" }] }),
    );
    await configureFakeLlm(server.url, fakeLlm.url);
    const genRes = await fetch(
      `${server.url}/api/sessions/${sessionId}/flashcards/generate`,
      { method: "POST" },
    );
    const { flashcards } = await genRes.json();
    const cardId = flashcards[0].id;

    const delRes = await fetch(`${server.url}/api/flashcards/${cardId}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(204);

    const listRes = await fetch(`${server.url}/api/sessions/${sessionId}/flashcards`);
    const listBody = await listRes.json();
    expect(listBody).toHaveLength(0);
  });

  it("returns 404 when deleting an unknown flashcard", async () => {
    server = await startWithMigratedDb();

    const res = await fetch(`${server.url}/api/flashcards/does-not-exist`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });
});

/**
 * Two-protocol fake LLM (pipeline contract): the assessment call
 * (stream:false) gets a JSON reply, the generation call (stream:true) gets
 * an SSE stream with the given reply.
 */
function startFakeSseServerReply(
  reply: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const VALID_ASSESSMENT = JSON.stringify({
    correctness: "partially_correct",
    completeness: "partial",
    reasoningQuality: "weak",
    misconceptions: [],
    userSignals: [],
    evidenceQuotes: [],
    coveredKpIds: [],
    focus: null,
  });
  return new Promise((resolve) => {
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
