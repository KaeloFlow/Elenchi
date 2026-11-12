/**
 * Scripted end-to-end smoke against the REAL built server (dist/cli.js):
 * fake LLM -> upload -> prepare -> lessons -> createSession (opening) ->
 * send (assessment+generation) -> close flow assertions.
 * Run from apps/server: node ../../scripts/e2e-smoke.mjs (or anywhere).
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "../apps/server");
const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
}

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

const JSON_PAYLOADS = [
  // assessment 1: incorrect with misconception
  JSON.stringify({
    correctness: "incorrect",
    completeness: "missing_reasoning",
    reasoningQuality: "none",
    misconceptions: ["误解A"],
    userSignals: [],
    evidenceQuotes: ["极限是微积分的基础概念"],
    coveredKpIds: [],
    focus: "极限",
  }),
  // assessment 2: solid covering kp-1 -> mastery accumulation
  JSON.stringify({
    correctness: "correct",
    completeness: "complete",
    reasoningQuality: "sound",
    misconceptions: [],
    userSignals: [],
    evidenceQuotes: ["数列极限描述项无限趋近的过程"],
    coveredKpIds: ["__FIRST_KP__"],
    focus: null,
  }),
];
let jsonCalls = 0;

// Response chosen by prompt role, not call order: the prep pipeline fans out
// per-section audit calls (plus gap re-extracts), so a flat queue misaligns.
const EXTRACT_OK = JSON.stringify({
  knowledgePoints: [
    { statement: "数列极限描述项无限趋近的过程", type: "concept", evidenceQuotes: ["数列极限描述项无限趋近的过程"], sectionIndex: 1 },
    { statement: "函数极限把趋近过程推广到连续变量", type: "concept", evidenceQuotes: ["它把趋近过程推广到连续变量"], sectionIndex: 2 },
    { statement: "极限是微积分的基础概念", type: "fact", evidenceQuotes: ["极限是微积分的基础概念"], sectionIndex: 1 },
  ],
});
const AUDIT_OK = JSON.stringify({ uncoveredQuotes: [] });
const SCHEDULE_OK = JSON.stringify({
  lessons: [
    { title: "第 1 课 极限的直观", objective: "理解极限的直观含义与基础概念", kpIndices: [0, 1, 2] },
  ],
});
const OPENING_OK = JSON.stringify({
  choices: [{ message: { content: "开场：你还记得极限是什么吗？" } }],
});

function rolePayload(requestBody) {
  const text = JSON.stringify(requestBody);
  if (text.includes("知识点抽取器")) return EXTRACT_OK;
  if (text.includes("覆盖审计器")) return AUDIT_OK;
  if (text.includes("课程排课器")) return SCHEDULE_OK;
  if (text.includes("这是本课的开场")) return OPENING_OK;
  // assessment: consume the scripted queue in order
  const idx = Math.min(jsonCalls, JSON_PAYLOADS.length - 1);
  jsonCalls += 1;
  return JSON_PAYLOADS[idx];
}

const fakeLlm = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    if (parsed.stream !== false) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const reply = "先别急。⅓ × 3 等于多少？";
      // Single write: per-char writes turned out to interleave badly with
      // the local loopback, splitting the stream after the first delta.
      res.write(
        reply
          .split("")
          .map((ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`)
          .join(""),
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    let payload = rolePayload(parsed);
    // Swap the placeholder for the real first KP id (unknown until prep).
    if (payload.includes("__FIRST_KP__")) {
      payload = payload.replace("__FIRST_KP__", globalThis.firstKpId ?? "kp-unknown");
    }
    const wrapped = payload.includes('"choices"')
      ? payload
      : JSON.stringify({ choices: [{ message: { content: payload } }] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(wrapped);
  });
});
await new Promise((r) => fakeLlm.listen(0, "127.0.0.1", r));
const llmPort = fakeLlm.address().port;
console.log(`fake LLM at http://127.0.0.1:${llmPort}`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-e2e-"));
// The real CLI does not migrate on boot (by design: `pnpm db:migrate` owns
// schema management), so apply the drizzle migrations first, as tests do.
{
  const createRequire = (await import("node:module")).createRequire;
  const requireFromServer = createRequire(
    path.join(SERVER_DIR, "package.json"),
  );
  const Database = requireFromServer("better-sqlite3");
  const sqlite = new Database(path.join(dataDir, "elenchi.sqlite3"));
  const migrationsDir = path.join(SERVER_DIR, "drizzle");
  for (const f of fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, f), "utf-8"));
  }
  sqlite.close();
}
const child = spawn(process.execPath, ["dist/cli.js"], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    ELENCHI_DATA_DIR: dataDir,
    ELENCHI_PORT: "0",
    ELENCHI_HOST: "127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverUrl = "";
child.stdout.on("data", (d) => {
  const m = String(d).match(/listening at (https?:\/\/[^\s"}]+)/);
  if (m && !serverUrl) serverUrl = m[1];
});
child.stderr.on("data", (d) => console.error("[server]", String(d)));
for (let i = 0; i < 60 && !serverUrl; i++) {
  await new Promise((r) => setTimeout(r, 250));
}
if (!serverUrl) {
  console.error("server did not report its URL; aborting");
  child.kill();
  process.exit(1);
}
console.log(`server at ${serverUrl}`);

async function api(p, opts) {
  const res = await fetch(`${serverUrl}${p}`, opts);
  return res;
}

try {
  // health
  const health = await (await api("/api/health")).json();
  check("health ok", health.status === "ok");

  // configure fake LLM
  await api("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${llmPort}`, apiKey: "sk-test", model: "test-model" }),
  });

  // upload material
  const form = new FormData();
  form.append("file", new Blob([SAMPLE_MD], { type: "text/markdown" }), "calc.md");
  const matRes = await api("/api/materials", { method: "POST", body: form });
  const matBody = await matRes.json();
  check("material uploaded", !!matBody.id, `status=${matRes.status} body=${JSON.stringify(matBody)}`);
  const materialId = matBody.id;

  const chunks = await (await api(`/api/materials/${materialId}/chunks`)).json();
  const chapter = chunks.find((c) => c.title.includes("第一章"));
  check("chapter chunk exists", !!chapter);

  // prep
  const prepRes = await api(`/api/chunks/${chapter.id}/prepare`, { method: "POST" });
  const prepBody = await prepRes.json();
  check("prep ready", prepRes.status === 200 && prepBody.status === "ready", JSON.stringify(prepBody));

  const lessonsBody = await (await api(`/api/chunks/${chapter.id}/lessons`)).json();
  check("lessons listed", lessonsBody.status === "ready" && lessonsBody.lessons.length === 1);
  const lesson = lessonsBody.lessons[0];
  check("lesson progress 0/n", lesson.masteredKpCount === 0 && lesson.kpCount === 3);

  // first KP id for the closed-set assessment payload
  const createRequire = (await import("node:module")).createRequire;
  const requireFromServer = createRequire(
    path.join(SERVER_DIR, "package.json"),
  );
  const db = requireFromServer("better-sqlite3");
  const sqlite = new db(path.join(dataDir, "elenchi.sqlite3"));
  globalThis.firstKpId = sqlite.prepare(`SELECT id FROM knowledge_points ORDER BY "order" LIMIT 1`).get().id;
  sqlite.close();

  // create session with opening
  const createRes = await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lessonId: lesson.id }),
  });
  const created = await createRes.json();
  check(
    "session created with opening",
    createRes.status === 200 && created.openingMessage?.content?.includes("你还记得极限是什么吗"),
    `status=${createRes.status} body=${JSON.stringify(created)}`,
  );

  // reuse omits opening
  const reuse = await (await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lessonId: lesson.id }),
  })).json();
  check("session reuse omits opening", reuse.id === created.id && !reuse.openingMessage);

  // send 1: incorrect answer -> streamed reply
  const send1 = await fetch(`${serverUrl}/api/sessions/${created.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "0.999... 不可能等于 1 吧" }),
  });
  const sse = await send1.text();
  // Deltas arrive as separate SSE events; join them before asserting.
  const events = sse
    .split("\n\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice("data:".length).trim()));
  const joined = events
    .filter((e) => "delta" in e)
    .map((e) => e.delta)
    .join("");
  check(
    "send1 streams reply",
    joined.includes("先别急") && events.some((e) => "done" in e),
    `joined=${joined}`,
  );

  // send 2: solid answer covering first KP -> mastery
  const send2 = await fetch(`${serverUrl}/api/sessions/${created.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "我懂了：数列极限描述项无限趋近的过程。" }),
  });
  await send2.text();

  // mastery reflected in lessons progress
  const after = await (await api(`/api/chunks/${chapter.id}/lessons`)).json();
  check("mastery accumulated", after.lessons[0].masteredKpCount === 1, `masteredKpCount=${after.lessons[0].masteredKpCount}`);
} catch (err) {
  check("e2e ran without exception", false, String(err));
} finally {
  child.kill();
  fakeLlm.close();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows may still hold the sqlite handle briefly after kill.
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
