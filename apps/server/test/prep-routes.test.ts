import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import Database from "better-sqlite3";
import { startServer, type StartedServer } from "../src/server.js";
import { createDb } from "../src/db/client.js";
import { lessonCardVersions } from "../src/db/schema.js";
import { sourceFingerprint } from "../src/prep/publication.js";

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

/**
 * Fake LLM serving all four prep call kinds (extract / audit / schedule /
 * any retry) as stream:false JSON. Payloads are consumed in call order; the
 * last payload repeats.
 */
function startFakePrepLlm(payloads: string[]): Promise<{
  url: string;
  close: () => Promise<void>;
  calls: () => number;
}> {
  return new Promise((resolve) => {
    let calls = 0;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        calls += 1;
        const payload = payloads[Math.min(calls - 1, payloads.length - 1)]!;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: payload } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        calls: () => calls,
      });
    });
  });
}

describe("prep routes", () => {
  let server: StartedServer | undefined;
  let tmpDir: string;
  let fakeLlm: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await server?.close();
    await fakeLlm?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startWithMigratedDb(): Promise<StartedServer> {
    const badPorts = new Set([5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 10080]);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-prep-route-"));
    // startServer applies Drizzle migrations automatically; avoid the small set
    // of ports WHATWG fetch rejects before opening a socket on Windows.
    const started = await startServer({ dataDir: tmpDir, port: 0 });
    if (badPorts.has(started.port)) {
      await started.close(); fs.rmSync(tmpDir, { recursive: true, force: true });
      return startWithMigratedDb();
    }
    return started;
  }

  async function importSampleMaterial(): Promise<{ materialId: string; chapterChunkId: string }> {
    const form = new FormData();
    form.append("file", new Blob([SAMPLE_MD], { type: "text/markdown" }), "calc.md");
    const res = await fetch(`${server!.url}/api/materials`, {
      method: "POST",
      body: form,
    });
    const { id } = await res.json();
    const chunksRes = await fetch(`${server!.url}/api/materials/${id}/chunks`);
    const chunks = await chunksRes.json();
    // Chapter mode: pick the real chapter chunk (two chapter-like headings
    // exist, so the chapter keeps its sub-sections inside one chunk).
    const chapter = chunks.find((c: { title: string }) =>
      c.title.includes("第一章"),
    );
    return { materialId: id, chapterChunkId: chapter.id };
  }

  async function configureSettings(baseUrl: string): Promise<void> {
    await fetch(`${server!.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey: "sk-test", model: "test-model" }),
    });
  }

  it("reports not_prepared before any prep and 404 for unknown chunks", async () => {
    server = await startWithMigratedDb();
    const { chapterChunkId: chunkId } = await importSampleMaterial();

    const res = await fetch(`${server.url}/api/chunks/${chunkId}/lessons`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_prepared" });

    const missing = await fetch(`${server.url}/api/chunks/nope/lessons`);
    expect(missing.status).toBe(404);
  });

  it("reports no evidence card before publication", async () => {
    server = await startWithMigratedDb();
    const { chapterChunkId: chunkId } = await importSampleMaterial();
    const prepRes = await fetch(`${server.url}/api/chunks/${chunkId}/lessons`);
    expect(prepRes.status).toBe(200);
    expect(await prepRes.json()).toEqual({ status: "not_prepared" });
  });

  it("runs the full prep pipeline and exposes lessons with progress", async () => {
    fakeLlm = await startFakePrepLlm([OK_EXTRACTION, OK_AUDIT, OK_SCHEDULE]);
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const { chapterChunkId: chunkId } = await importSampleMaterial();

    const prepRes = await fetch(`${server.url}/api/chunks/${chunkId}/prepare`, {
      method: "POST",
    });
    expect(prepRes.status).toBe(200);
    const prepBody = await prepRes.json();
    expect(prepBody).toMatchObject({ status: "ready", lessonCount: 1 });

    const lessonsRes = await fetch(`${server.url}/api/chunks/${chunkId}/lessons`);
    const lessonsBody = await lessonsRes.json();
    expect(lessonsBody.status).toBe("ready");
    expect(lessonsBody.lessons).toHaveLength(1);
    const summaryRes = await fetch(`${server.url}/api/lessons/${lessonsBody.lessons[0].id}/quality-summary`);
    expect(await summaryRes.json()).toEqual({ lessonId: lessonsBody.lessons[0].id, cardVersion: null, taskCount: 0, requirementCount: 0, independentRequirementCount: 0 });
    expect(lessonsBody.lessons[0]).toMatchObject({
      order: 1,
      kpCount: 3,
      masteredKpCount: 0,
      status: "active",
    });

    // Idempotent: a ready chunk does not call the LLM again.
    const callsBefore = fakeLlm.calls();
    await fetch(`${server.url}/api/chunks/${chunkId}/prepare`, { method: "POST" });
    expect(fakeLlm.calls()).toBe(callsBefore);
  });

  it("reports exact task and independent requirement counts for a published card", async () => {
    fakeLlm = await startFakePrepLlm([OK_EXTRACTION, OK_AUDIT, OK_SCHEDULE]);
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const { chapterChunkId: chunkId } = await importSampleMaterial();
    await fetch(`${server.url}/api/chunks/${chunkId}/prepare`, { method: "POST" });
    const body = await (await fetch(`${server.url}/api/chunks/${chunkId}/lessons`)).json();
    const lesson = body.lessons?.[0];
    const db = createDb(tmpDir, { migrate: false });
    const card = { version: "summary-card", lessonId: lesson.id, sourceHash: sourceFingerprint(SAMPLE_MD), learnerVersion: sourceFingerprint("null"), rulesVersion: "r", objective: "目标", knowledge: [{ id: "k1", statement: "一", type: "concept", evidence: ["数列极限描述项无限趋近的过程"], conditions: [], exceptions: [] }, { id: "k2", statement: "二", type: "fact", evidence: ["极限是微积分的基础概念"], conditions: [], exceptions: [] }, { id: "k3", statement: "三", type: "concept", evidence: ["它把趋近过程推广到连续变量"], conditions: [], exceptions: [] }], requirements: [{ id: "r1", kpId: "k1", kind: "recall", criterion: "一", independent: true }, { id: "r2", kpId: "k2", kind: "explanation", criterion: "二", independent: true }, { id: "r3", kpId: "k3", kind: "application", criterion: "三", independent: false }], tasks: [{ id: "t1", requirementIds: ["r1"], question: "一", rubric: "一", acceptableVariants: [], hints: [] }, { id: "t2", requirementIds: ["r2", "r3"], question: "二三", rubric: "二三", acceptableVariants: [], hints: [] }] };
    db.db.insert(lessonCardVersions).values({ version: card.version, lessonId: lesson.id, taskId: "quality-task", sourceHash: card.sourceHash, learnerVersion: card.learnerVersion, rulesVersion: card.rulesVersion, payload: JSON.stringify(card), publishedAt: new Date() }).run(); db.close();
    const summary = await (await fetch(`${server.url}/api/lessons/${lesson.id}/quality-summary`)).json();
    expect(summary).toEqual({ lessonId: lesson.id, cardVersion: "summary-card", taskCount: 2, requirementCount: 3, independentRequirementCount: 2 });
  });

  it("records a failed prep with 502 and keeps it retryable", async () => {
    fakeLlm = await startFakePrepLlm(["彻底不是 JSON"]);
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const { chapterChunkId: chunkId } = await importSampleMaterial();

    const prepRes = await fetch(`${server.url}/api/chunks/${chunkId}/prepare`, {
      method: "POST",
    });
    expect(prepRes.status).toBe(502);
    const body = await prepRes.json();
    expect(body.error).toBe("prep_failed");

    const lessonsRes = await fetch(`${server.url}/api/chunks/${chunkId}/lessons`);
    const lessonsBody = await lessonsRes.json();
    expect(lessonsBody.status).toBe("failed");
    expect(lessonsBody.error).toBeTruthy();

    // Retry with a working LLM succeeds (clean re-run).
    await fakeLlm.close();
    fakeLlm = await startFakePrepLlm([OK_EXTRACTION, OK_AUDIT, OK_SCHEDULE]);
    await configureSettings(fakeLlm.url);
    const retry = await fetch(`${server.url}/api/chunks/${chunkId}/prepare`, {
      method: "POST",
    });
    expect(retry.status).toBe(200);
  });

  it("rejects prepare without configured LLM (400)", async () => {
    server = await startWithMigratedDb();
    const { chapterChunkId: chunkId } = await importSampleMaterial();
    const res = await fetch(`${server.url}/api/chunks/${chunkId}/prepare`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("llm_not_configured");
  });

  it("lists lesson KPs with mastery marks and 404s unknown lessons", async () => {
    fakeLlm = await startFakePrepLlm([OK_EXTRACTION, OK_AUDIT, OK_SCHEDULE]);
    server = await startWithMigratedDb();
    await configureSettings(fakeLlm.url);
    const { chapterChunkId: chunkId } = await importSampleMaterial();
    await fetch(`${server.url}/api/chunks/${chunkId}/prepare`, {
      method: "POST",
    });
    const lessonsBody = await (
      await fetch(`${server.url}/api/chunks/${chunkId}/lessons`)
    ).json();
    const lessonId = lessonsBody.lessons[0].id as string;

    const res = await fetch(`${server.url}/api/lessons/${lessonId}/kps`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kps).toHaveLength(3);
    for (const kp of body.kps) {
      expect(kp.statement).toBeTruthy();
      expect(kp.mastered).toBe(false);
    }

    const missing = await fetch(`${server.url}/api/lessons/nope/kps`);
    expect(missing.status).toBe(404);
  });
});
