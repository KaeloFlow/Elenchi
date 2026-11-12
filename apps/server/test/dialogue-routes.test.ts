import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import Database from "better-sqlite3";
import { startServer, type StartedServer } from "../src/server.js";

// Two chapters so the chunker runs in chapter mode and the prep pipeline
// gets a real chapter chunk (single-chapter samples fall back to level
// splitting and produce intro-only chunks the pipeline rejects).
const SAMPLE_MD = [
  "# 微积分教程",
  "这是一本测试教材。",
  "",
  "# 第一章 极限",
  "本章讲极限的直观含义。",
  "",
  "## 1.1 数列极限",
  "数列极限描述项无限趋近的过程。极限是微积分的基础概念。",
  "",
  "## 1.2 函数极限",
  "函数极限与数列极限思想一致。它把趋近过程推广到连续变量。",
  "",
  "# 第二章 导数",
  "导数描述变化率。",
].join("\n");

const OK_EXTRACTION = JSON.stringify({
  knowledgePoints: [
    {
      statement: "数列极限描述项无限趋近的过程",
      type: "concept",
      evidenceQuotes: ["数列极限描述项无限趋近的过程"],
      sectionIndex: 1,
    },
    {
      statement: "函数极限把趋近过程推广到连续变量",
      type: "concept",
      evidenceQuotes: ["它把趋近过程推广到连续变量"],
      sectionIndex: 2,
    },
    {
      statement: "极限是微积分的基础概念",
      type: "fact",
      evidenceQuotes: ["极限是微积分的基础概念"],
      sectionIndex: 1,
    },
  ],
});

const OK_AUDIT = JSON.stringify({ uncoveredQuotes: [] });

const OK_SCHEDULE = JSON.stringify({
  lessons: [
    {
      title: "第 1 课 极限的直观",
      objective: "理解极限的直观含义与基础概念",
      kpIndices: [0, 1, 2],
    },
  ],
});

const OK_OPENING = JSON.stringify({
  choices: [
    {
      message: {
        content: "欢迎来到本课。上一课我们理解了数列的趋近过程。你还记得极限是什么吗？",
      },
    },
  ],
});

const VALID_ASSESSMENT = {
  correctness: "incorrect",
  completeness: "missing_reasoning",
  reasoningQuality: "none",
  misconceptions: ["把无限小数理解为永远接近但不能等于"],
  userSignals: [],
  evidenceQuotes: ["极限是微积分的基础概念"],
  coveredKpIds: [],
  focus: "0.999... 与 1 的关系",
};

/**
 * Fake LLM for the full lesson flow. All non-stream calls (prep extract /
 * audit / schedule, opening generation, assessment) consume `jsonPayloads`
 * in call order — the raw JSON of each response, so the caller mixes
 * "message-content" payloads and full response shapes freely. Stream calls
 * (generation) replay `generationReply` as an SSE delta stream.
 */
function startFakeLessonLlm(options: {
  jsonPayloads: string[];
  generationReply: string;
}): Promise<{
  url: string;
  close: () => Promise<void>;
  calls: () => number;
  lastGenerationMessages: () => { role: string; content: string }[];
}> {
  return new Promise((resolve) => {
    let jsonCalls = 0;
    let generationMessages: { role: string; content: string }[] = [];
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
        if (parsed.stream !== false) {
          generationMessages = Array.isArray(parsed.messages)
            ? parsed.messages.filter(
                (message): message is { role: string; content: string } =>
                  typeof message === "object" &&
                  message !== null &&
                  typeof message.role === "string" &&
                  typeof message.content === "string",
              )
            : [];
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const ch of options.generationReply) {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`,
            );
          }
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        const idx = Math.min(jsonCalls, options.jsonPayloads.length - 1);
        jsonCalls += 1;
        const payload = options.jsonPayloads[idx]!;
        // Full-response payloads start with "{" and contain "choices";
        // plain message-content payloads get wrapped.
        const wrapped = payload.includes('"choices"')
          ? payload
          : JSON.stringify({ choices: [{ message: { content: payload } }] });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(wrapped);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        calls: () => jsonCalls,
        lastGenerationMessages: () => generationMessages,
      });
    });
  });
}

function startFailingLlmServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "boom" }));
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

async function readSseBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("dialogue routes (lesson-anchored, v3)", () => {
  let server: StartedServer | undefined;
  let tmpDir: string;
  let fakeLlm:
    | {
        url: string;
        close: () => Promise<void>;
        calls: () => number;
        lastGenerationMessages: () => { role: string; content: string }[];
      }
    | undefined;

  afterEach(async () => {
    await server?.close();
    await fakeLlm?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startWithMigratedDb(): Promise<StartedServer> {
    const badPorts = new Set([5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 10080]);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-dialogue-route-"));
    // Keep fetch-based fixtures away from WHATWG's forbidden-port list.
    const started = await startServer({ dataDir: tmpDir, port: 0 });
    if (badPorts.has(started.port)) {
      await started.close(); fs.rmSync(tmpDir, { recursive: true, force: true });
      return startWithMigratedDb();
    }
    return started;
  }

  async function configureSettings(baseUrl: string): Promise<void> {
    await fetch(`${server!.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl,
        apiKey: "sk-test",
        model: "test-model",
      }),
    });
  }

  /** Prep the sample material and return the first lesson id. */
  async function prepAndGetFirstLessonId(): Promise<string> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([SAMPLE_MD], { type: "text/markdown" }),
      "calc.md",
    );
    const matRes = await fetch(`${server!.url}/api/materials`, {
      method: "POST",
      body: form,
    });
    const { id: materialId } = await matRes.json();
    const chunksRes = await fetch(
      `${server!.url}/api/materials/${materialId}/chunks`,
    );
    const chunks = await chunksRes.json();
    const chapter = chunks.find((c: { title: string }) =>
      c.title.includes("第一章"),
    );

    const prepRes = await fetch(
      `${server!.url}/api/chunks/${chapter.id}/prepare`,
      { method: "POST" },
    );
    expect(prepRes.status).toBe(200);

    const lessonsRes = await fetch(
      `${server!.url}/api/chunks/${chapter.id}/lessons`,
    );
    const lessonsBody = await lessonsRes.json();
    expect(lessonsBody.status).toBe("ready");
    return lessonsBody.lessons[0].id as string;
  }

  function openDb(): {
    query: (sql: string) => unknown[];
    close: () => void;
  } {
    const sqlite = new Database(path.join(tmpDir, "elenchi.sqlite3"));
    return {
      query: (sql: string) => sqlite.prepare(sql).all() as unknown[],
      close: () => sqlite.close(),
    };
  }

  it("creates a session with a generated opening message; reuse omits it", async () => {
    fakeLlm = await startFakeLessonLlm({
      jsonPayloads: [OK_EXTRACTION, OK_AUDIT, OK_SCHEDULE, OK_OPENING],
      generationReply: "不应被调用",
    });
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const lessonId = await prepAndGetFirstLessonId();

    const createRes = await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId }),
    });
    expect(createRes.status).toBe(200);
    const body = await createRes.json();
    expect(body.lessonId).toBe(lessonId);
    expect(body.openingMessage).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("你还记得极限是什么吗"),
    });

    // Reuse: same session, no new opening, no extra LLM call.
    const callsBefore = fakeLlm.calls();
    const reuseRes = await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId }),
    });
    const reuseBody = await reuseRes.json();
    expect(reuseBody.id).toBe(body.id);
    expect(reuseBody.openingMessage).toBeUndefined();
    expect(fakeLlm.calls()).toBe(callsBefore);

    // The opening is persisted as the first message.
    const historyRes = await fetch(`${server.url}/api/sessions/${body.id}/messages`);
    const history = await historyRes.json();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: "assistant" });
  });

  it("returns 404 when creating a session for an unknown lesson", async () => {
    server = await startWithMigratedDb();
    const res = await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 502 opening_failed and persists nothing when opening generation fails", async () => {
    // Prep needs a working fake; opening generation needs a failing one.
    fakeLlm = await startFakeLessonLlm({
      jsonPayloads: [OK_EXTRACTION, OK_AUDIT, OK_SCHEDULE],
      generationReply: "",
    });
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const lessonId = await prepAndGetFirstLessonId();
    await fakeLlm.close();
    fakeLlm = await startFailingLlmServer();
    await configureSettings(fakeLlm.url);

    const res = await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("opening_failed");

    const db = openDb();
    try {
      expect(db.query("SELECT * FROM sessions")).toHaveLength(0);
      expect(db.query("SELECT * FROM messages")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("rejects posting to a legacy (lesson-less) session with 409", async () => {
    server = await startWithMigratedDb();
    // Seed a v2-style session row directly (lesson_id NULL = legacy).
    const db = new Database(path.join(tmpDir, "elenchi.sqlite3"));
    const legacyId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO materials (id, title, source_path, created_at) VALUES ('m1', 't', '/tmp/t.md', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO material_chunks (id, material_id, "order", title, level, content) VALUES ('c1', 'm1', 1, '第一章', 1, '内容')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, material_id, chunk_id, lesson_id, started_at) VALUES (?, 'm1', 'c1', NULL, 1)`,
    ).run(legacyId);
    db.close();

    const res = await fetch(`${server.url}/api/sessions/${legacyId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("legacy_session_readonly");
  });

  it("returns 400 when sending a message without LLM settings configured", async () => {
    server = await startWithMigratedDb();
    // Seed a lesson-anchored session directly, then send with no settings
    // configured at all (no fake LLM ever configured in this test).
    const db = new Database(path.join(tmpDir, "elenchi.sqlite3"));
    const legacyMaterial = "m1";
    db.prepare(
      `INSERT INTO materials (id, title, source_path, created_at) VALUES (?, 't', '/tmp/t.md', 1)`,
    ).run(legacyMaterial);
    db.prepare(
      `INSERT INTO material_chunks (id, material_id, "order", title, level, content) VALUES ('c1', ?, 1, '第一章', 1, '内容')`,
    ).run(legacyMaterial);
    db.prepare(
      `INSERT INTO knowledge_points (id, material_id, chunk_id, "order", statement, type, section_index, section_title, evidence, created_at)
       VALUES ('kp1', ?, 'c1', 1, 'KP', 'fact', 0, 's', '[]', 1)`,
    ).run(legacyMaterial);
    db.prepare(
      `INSERT INTO lessons (id, material_id, chunk_id, "order", title, objective, kp_ids, auto_packed, status, created_at)
       VALUES ('l1', ?, 'c1', 1, '第 1 课', '目标', '["kp1"]', 0, 'active', 1)`,
    ).run(legacyMaterial);
    db.prepare(
      `INSERT INTO sessions (id, material_id, chunk_id, lesson_id, started_at)
       VALUES ('s1', ?, 'c1', 'l1', 1)`,
    ).run(legacyMaterial);
    db.close();

    const res = await fetch(`${server.url}/api/sessions/s1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "0.999... 不可能等于 1 吧" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("llm_not_configured");
  });

  it("runs the two-call pipeline, streams the reply, and persists messages+turn+state", async () => {
    fakeLlm = await startFakeLessonLlm({
      jsonPayloads: [
        OK_EXTRACTION,
        OK_AUDIT,
        OK_SCHEDULE,
        OK_OPENING,
        JSON.stringify(VALID_ASSESSMENT),
      ],
      generationReply: "先别急，想想 ⅓ × 3。",
    });
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const lessonId = await prepAndGetFirstLessonId();
    const createRes = await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${server.url}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "0.999... 不可能等于 1 吧" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const sseBody = await readSseBody(res);
    const dataLines = sseBody
      .split("\n\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice("data:".length).trim()));

    const deltas = dataLines
      .filter((e) => "delta" in e)
      .map((e) => e.delta)
      .join("");
    expect(deltas).toBe("先别急，想想 ⅓ × 3。");
    const doneEvent = dataLines.find((e) => "done" in e) as {
      userMessageId: string;
      messageId: string;
    };
    expect(doneEvent).toBeTruthy();

    // messages persisted: opening + user + assistant
    const historyRes = await fetch(`${server.url}/api/sessions/${id}/messages`);
    const history = await historyRes.json();
    expect(history).toHaveLength(3);
    expect(history[1].id).toBe(doneEvent.userMessageId);
    expect(history[2].id).toBe(doneEvent.messageId);
    expect(history[1]).toMatchObject({
      role: "user",
      content: "0.999... 不可能等于 1 吧",
    });
    expect(history[2]).toMatchObject({
      role: "assistant",
      content: "先别急，想想 ⅓ × 3。",
    });

    // turn + state persisted (incorrect answer with a misconception ->
    // probe_assumption action; hint ratchet 0 -> 1)
    const db = openDb();
    try {
      const turns = db.query("SELECT * FROM session_turns") as {
        user_message_id: string;
        assistant_message_id: string;
        assessment: string;
        action: string;
      }[];
      expect(turns).toHaveLength(1);
      expect(turns[0]!.user_message_id).toBe(doneEvent.userMessageId);
      expect(turns[0]!.assistant_message_id).toBe(doneEvent.messageId);
      expect(JSON.parse(turns[0]!.assessment)).toMatchObject({
        correctness: "incorrect",
      });
      expect(JSON.parse(turns[0]!.action)).toMatchObject({
        actionType: "probe_assumption",
        hintLevel: 1,
      });

      const states = db.query("SELECT * FROM session_pedagogy_state") as {
        hint_level: number;
        stuck_counter: number;
      }[];
      expect(states).toHaveLength(1);
      expect(states[0]!.hint_level).toBe(1);
      expect(states[0]!.stuck_counter).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rebuilds the generation card around the reducer's advanced target", async () => {
    const advanceAssessment = JSON.stringify({
      correctness: "correct",
      completeness: "complete",
      reasoningQuality: "sound",
      misconceptions: [],
      userSignals: [],
      evidenceQuotes: ["数列极限描述项无限趋近的过程"],
      coveredKpIds: [],
      focus: null,
    });
    fakeLlm = await startFakeLessonLlm({
      jsonPayloads: [
        JSON.stringify({ ...JSON.parse(advanceAssessment), coveredKpIds: ["kp-1"] }),
      ],
      generationReply: "请比较函数极限与数列极限。",
    });
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const dbPath = path.join(tmpDir, "elenchi.sqlite3");
    const fixture = new Database(dbPath);
    try {
      fixture.exec(`
        INSERT INTO materials (id, title, source_path, created_at) VALUES ('m-focus', '测试教材', '/tmp/focus.md', 1);
        INSERT INTO material_chunks (id, material_id, "order", title, level, content) VALUES ('c-focus', 'm-focus', 1, '第一章', 1, '# 第一章\n## 第一节\n数列极限描述项无限趋近的过程。极限是微积分的基础概念。\n## 第二节\n函数极限与数列极限思想一致。它把趋近过程推广到连续变量。');
        INSERT INTO knowledge_points (id, material_id, chunk_id, "order", statement, type, section_index, section_title, evidence, created_at) VALUES
          ('kp-1', 'm-focus', 'c-focus', 1, '数列极限描述项无限趋近的过程', 'concept', 0, '第一节', '["数列极限描述项无限趋近的过程"]', 1),
          ('kp-2', 'm-focus', 'c-focus', 2, '函数极限把趋近过程推广到连续变量', 'concept', 1, '第二节', '["它把趋近过程推广到连续变量"]', 1);
        INSERT INTO lessons (id, material_id, chunk_id, "order", title, objective, kp_ids, auto_packed, status, created_at) VALUES ('l-focus', 'm-focus', 'c-focus', 1, '极限', '比较两类极限', '["kp-1","kp-2"]', 0, 'active', 1);
        INSERT INTO sessions (id, material_id, chunk_id, lesson_id, started_at) VALUES ('s-focus', 'm-focus', 'c-focus', 'l-focus', 1);
      `);
    } finally {
      fixture.close();
    }

    const res = await fetch(`${server.url}/api/sessions/s-focus/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "数列的项会趋近一个值。" }),
    });
    expect(res.status).toBe(200);
    await readSseBody(res);

    const db = openDb();
    try {
      const turn = db.query("SELECT action FROM session_turns")[0] as {
        action: string;
      };
      expect(JSON.parse(turn.action)).toMatchObject({
        actionType: "advance",
        targetKpId: "kp-2",
      });
      const systemPrompt = fakeLlm!.lastGenerationMessages().find(
        (message) => message.role === "system",
      )!.content;
      expect(systemPrompt).toContain("函数极限与数列极限思想一致");
      expect(systemPrompt).not.toContain("数列极限描述项无限趋近的过程。极限是微积分的基础概念。");
    } finally {
      db.close();
    }
  });

  it("advances the hint ratchet across two low-quality turns", async () => {
    fakeLlm = await startFakeLessonLlm({
      jsonPayloads: [
        OK_EXTRACTION,
        OK_AUDIT,
        OK_SCHEDULE,
        OK_OPENING,
        JSON.stringify(VALID_ASSESSMENT),
      ],
      generationReply: "好。",
    });
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const lessonId = await prepAndGetFirstLessonId();
    const createRes = await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId }),
    });
    const { id } = await createRes.json();

    for (const content of ["0.999... 不可能等于 1 吧", "还是不对吧"]) {
      const res = await fetch(`${server.url}/api/sessions/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      await readSseBody(res);
    }

    const db = openDb();
    try {
      const turns = db.query("SELECT * FROM session_turns") as unknown[];
      expect(turns).toHaveLength(2);
      const states = db.query("SELECT * FROM session_pedagogy_state") as {
        hint_level: number;
      }[];
      expect(states[0]!.hint_level).toBe(2);
    } finally {
      db.close();
    }
  });

  it("returns 502 and persists nothing when both assessment attempts are invalid", async () => {
    fakeLlm = await startFakeLessonLlm({
      jsonPayloads: [
        OK_EXTRACTION,
        OK_AUDIT,
        OK_SCHEDULE,
        OK_OPENING,
        "不是 JSON",
        "还是不是 JSON",
      ],
      generationReply: "不应被调用",
    });
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const lessonId = await prepAndGetFirstLessonId();
    const createRes = await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${server.url}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "0.999... 不可能等于 1 吧" }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("assessment_failed");

    // Only the pre-existing opening remains; no exchange, no turn, no state.
    const historyRes = await fetch(`${server.url}/api/sessions/${id}/messages`);
    const history = await historyRes.json();
    expect(history).toHaveLength(1);

    const db = openDb();
    try {
      expect(db.query("SELECT * FROM session_turns")).toHaveLength(0);
      expect(db.query("SELECT * FROM session_pedagogy_state")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("persists nothing when the LLM request fails outright (no orphan user row)", async () => {
    fakeLlm = await startFakeLessonLlm({
      jsonPayloads: [OK_EXTRACTION, OK_AUDIT, OK_SCHEDULE, OK_OPENING],
      generationReply: "",
    });
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const lessonId = await prepAndGetFirstLessonId();
    const createRes = await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId }),
    });
    const { id } = await createRes.json();

    // Switch to a failing LLM for the send itself.
    await fakeLlm.close();
    fakeLlm = await startFailingLlmServer();
    await configureSettings(fakeLlm.url);

    const res = await fetch(`${server.url}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "0.999... 不可能等于 1 吧" }),
    });

    // The assessment call gets an HTTP 500 from the fake LLM -> explicit
    // 502, zero persistence.
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("assessment_failed");

    const historyRes = await fetch(`${server.url}/api/sessions/${id}/messages`);
    const history = await historyRes.json();
    expect(history).toHaveLength(1); // opening only
  });

  it("treats an empty generation reply as failure and persists nothing (incl. turn/state)", async () => {
    fakeLlm = await startFakeLessonLlm({
      jsonPayloads: [
        OK_EXTRACTION,
        OK_AUDIT,
        OK_SCHEDULE,
        OK_OPENING,
        JSON.stringify(VALID_ASSESSMENT),
      ],
      generationReply: "",
    });
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const lessonId = await prepAndGetFirstLessonId();
    const createRes = await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${server.url}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "帮我想想" }),
    });
    const sseBody = await readSseBody(res);
    expect(sseBody).toContain(`"error"`);
    expect(sseBody).not.toContain(`"done"`);

    const historyRes = await fetch(`${server.url}/api/sessions/${id}/messages`);
    const history = await historyRes.json();
    expect(history).toHaveLength(1); // opening only

    const db = openDb();
    try {
      expect(db.query("SELECT * FROM session_turns")).toHaveLength(0);
      expect(db.query("SELECT * FROM session_pedagogy_state")).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
