import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import Database from "better-sqlite3";
import { startServer, type StartedServer } from "../src/server.js";

const SAMPLE_MD = [
  "# 第一章 极限",
  "极限是微积分的基础概念。",
  "",
  "## 1.1 数列极限",
  "数列极限的严格定义。",
  "",
  "# 第二章 导数",
  "导数描述函数的变化率。",
].join("\n");

describe("materials routes", () => {
  let server: StartedServer | undefined;
  let tmpDir: string;

  afterEach(async () => {
    await server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startWithMigratedDb(): Promise<StartedServer> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-materials-route-"));
    // startServer applies Drizzle migrations automatically; no extra exec needed.
    return startServer({ dataDir: tmpDir, port: 0 });
  }

  it("returns an empty list before any material is imported", async () => {
    server = await startWithMigratedDb();

    const res = await fetch(`${server.url}/api/materials`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  it("imports a markdown file via multipart upload and lists it", async () => {
    server = await startWithMigratedDb();

    const form = new FormData();
    form.append(
      "file",
      new Blob([SAMPLE_MD], { type: "text/markdown" }),
      "calculus.md",
    );

    const uploadRes = await fetch(`${server.url}/api/materials`, {
      method: "POST",
      body: form,
    });
    const uploadBody = await uploadRes.json();

    expect(uploadRes.status).toBe(201);
    // Chapter mode: 第一章/第二章 are real chapters; the "## 1.1" numbered
    // subsection stays inside 第一章's chunk instead of becoming a chapter.
    expect(uploadBody.chunkCount).toBe(2);

    const listRes = await fetch(`${server.url}/api/materials`);
    const list = await listRes.json();

    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("calculus");
    expect(list[0].chunkCount).toBe(2);
  });

  it("returns chunks in order for an imported material", async () => {
    server = await startWithMigratedDb();

    const form = new FormData();
    form.append(
      "file",
      new Blob([SAMPLE_MD], { type: "text/markdown" }),
      "calculus.md",
    );
    const uploadRes = await fetch(`${server.url}/api/materials`, {
      method: "POST",
      body: form,
    });
    const { id } = await uploadRes.json();

    const chunksRes = await fetch(`${server.url}/api/materials/${id}/chunks`);
    const chunks = await chunksRes.json();

    expect(chunksRes.status).toBe(200);
    expect(chunks.map((c: { title: string }) => c.title)).toEqual([
      "第一章 极限",
      "第二章 导数",
    ]);
    // The numbered subsection heading remains inside the chapter chunk.
    expect(chunks[0].content).toContain("## 1.1 数列极限");
  });

  it("rejects non-markdown files with 400", async () => {
    server = await startWithMigratedDb();

    const form = new FormData();
    form.append(
      "file",
      new Blob(["not markdown"], { type: "application/pdf" }),
      "book.pdf",
    );

    const res = await fetch(`${server.url}/api/materials`, {
      method: "POST",
      body: form,
    });

    expect(res.status).toBe(400);
  });

  it("returns 404 for chunks of a nonexistent material", async () => {
    server = await startWithMigratedDb();

    const res = await fetch(`${server.url}/api/materials/does-not-exist/chunks`);

    expect(res.status).toBe(404);
  });

  it("deletes a material and cascades its sessions, messages, turns, pedagogy state and prep rows", async () => {
    server = await startWithMigratedDb();

    const form = new FormData();
    form.append(
      "file",
      new Blob([SAMPLE_MD], { type: "text/markdown" }),
      "calc.md",
    );
    const uploadRes = await fetch(`${server.url}/api/materials`, {
      method: "POST",
      body: form,
    });
    const { id } = await uploadRes.json();
    const chunksRes = await fetch(`${server.url}/api/materials/${id}/chunks`);
    const [chunk] = await chunksRes.json();

    // Seed the full data web directly (the cascade test exercises deletion,
    // not the teaching pipeline): lesson-anchored session + messages +
    // pedagogy turn/state + prep rows + progress.
    const Database = (await import("better-sqlite3")).default;
    const sqlite = new Database(path.join(tmpDir, "elenchi.sqlite3"));
    const kpId = crypto.randomUUID();
    const lessonId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO knowledge_points (id, material_id, chunk_id, "order", statement, type, section_index, section_title, evidence, created_at)
         VALUES (?, ?, ?, 1, 'KP', 'fact', 0, 's', '[]', ?)`,
      )
      .run(kpId, id, chunk.id, now);
    sqlite
      .prepare(
        `INSERT INTO lessons (id, material_id, chunk_id, "order", title, objective, kp_ids, auto_packed, status, created_at)
         VALUES (?, ?, ?, 1, '第 1 课', '目标', ?, 0, 'active', ?)`,
      )
      .run(lessonId, id, chunk.id, JSON.stringify([kpId]), now);
    sqlite
      .prepare(
        `INSERT INTO sessions (id, material_id, chunk_id, lesson_id, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, id, chunk.id, lessonId, now);
    sqlite
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at)
         VALUES (?, ?, 'user', 'q', ?), (?, ?, 'assistant', 'a', ?)`,
      )
      .run(userId, sessionId, now, assistantId, sessionId, now + 1);
    sqlite
      .prepare(
        `INSERT INTO session_turns (id, session_id, user_message_id, assistant_message_id, assessment, action, created_at)
         VALUES (?, ?, ?, ?, '{}', '{}', ?)`,
      )
      .run(turnId, sessionId, userId, assistantId, now);
    sqlite
      .prepare(
        `INSERT INTO session_pedagogy_state (session_id, updated_at) VALUES (?, ?)`,
      )
      .run(sessionId, now);
    sqlite
      .prepare(
        `INSERT INTO chunk_prep (chunk_id, material_id, status, kp_count, lesson_count, prepared_at)
         VALUES (?, ?, 'ready', 1, 1, ?)`,
      )
      .run(chunk.id, id, now);
    sqlite
      .prepare(
        `INSERT INTO material_progress (material_id, mastered_kp_ids, open_misconceptions, updated_at)
         VALUES (?, '[]', '[]', ?)`,
      )
      .run(id, now);
    sqlite.close();

    const delRes = await fetch(`${server.url}/api/materials/${id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(204);

    const listRes = await fetch(`${server.url}/api/materials`);
    expect(await listRes.json()).toEqual([]);
    const chunksAfter = await fetch(`${server.url}/api/materials/${id}/chunks`);
    expect(chunksAfter.status).toBe(404);
    const messagesAfter = await fetch(
      `${server.url}/api/sessions/${sessionId}/messages`,
    );
    expect(messagesAfter.status).toBe(404);
    const flashcardsAfter = await fetch(
      `${server.url}/api/sessions/${sessionId}/flashcards`,
    );
    expect(flashcardsAfter.status).toBe(404);

    // Pedagogy evidence cascaded away with the material.
    const afterDb = new Database(path.join(tmpDir, "elenchi.sqlite3"));
    try {
      expect(afterDb.prepare("SELECT * FROM session_turns").all()).toHaveLength(0);
      expect(
        afterDb.prepare("SELECT * FROM session_pedagogy_state").all(),
      ).toHaveLength(0);
    } finally {
      afterDb.close();
    }
  });

  it("returns 404 when deleting an unknown material", async () => {
    server = await startWithMigratedDb();

    const res = await fetch(`${server.url}/api/materials/does-not-exist`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("material_not_found");
  });
});

/**
 * Two-protocol fake LLM (same contract as dialogue-routes.test.ts): the
 * assessment call (stream:false) gets a JSON reply, the generation call
 * (stream:true) gets an SSE stream.
 */
function startFakeTwoCallLlmServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const VALID_ASSESSMENT = JSON.stringify({
    correctness: "incorrect",
    completeness: "missing_reasoning",
    reasoningQuality: "none",
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
          const payload = assessmentCalls === 0 ? VALID_ASSESSMENT : VALID_ASSESSMENT;
          assessmentCalls += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ choices: [{ message: { content: payload } }] }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "先别急。" } }] })}\n\n`,
        );
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
