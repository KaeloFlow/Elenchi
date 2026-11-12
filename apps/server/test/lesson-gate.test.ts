import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { buildApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import { importMaterial, getMaterialChunks } from "../src/materials/store.js";
import { insertPrepResults, markLessonCompleted } from "../src/prep/store.js";
import { insertSessionWithOpening } from "../src/dialogue/store.js";
import { lessons } from "../src/db/schema.js";

/**
 * Lesson gate (create-session) route behavior: first entry into a lesson is
 * blocked with 409 lesson_locked while the previous lesson in the chapter is
 * not completed; revisits (existing session) bypass the gate; completing the
 * previous lesson unlocks. The lessons list exposes the same rule as the
 * `locked` flag. Direct DB manipulation stands in for the full dialogue flow
 * — the gate sits before any LLM work by design.
 */
describe("lesson gate routes", () => {
  let tmpDir: string;
  let handle: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let chunkId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-gate-"));
    const dbPath = path.join(tmpDir, "elenchi.sqlite3");
    const sqlite = new Database(dbPath);
    const migrationsDir = path.resolve("drizzle");
    for (const file of fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf-8"));
    }
    sqlite.close();
    handle = createDb(tmpDir);
    const config = resolveServerConfig({ dataDir: tmpDir, port: 0 });
    app = await buildApp(config, handle.db);

    const md = ["# 第1章 极限", "极限内容。"].join("\n");
    const material = importMaterial(handle.db, "测试教材", "/tmp/t.md", md);
    chunkId = getMaterialChunks(handle.db, material.id)[0]!.id;
    insertPrepResults(handle.db, {
      chunkId,
      materialId: material.id,
      kps: [
        {
          statement: "KP 一",
          type: "concept" as const,
          sectionIndex: 0,
          sectionTitle: "1.1",
          evidence: ["极限内容。"],
        },
        {
          statement: "KP 二",
          type: "fact" as const,
          sectionIndex: 0,
          sectionTitle: "1.1",
          evidence: ["极限内容。"],
        },
      ],
      lessons: [
        { title: "第 1 课", objective: "o", kpIndices: [0] },
        { title: "第 2 课", objective: "o2", kpIndices: [1] },
      ],
      partialSections: 0,
      autoPackedLessons: 0,
    });

    // Settings must exist for the create-session route to reach the gate.
    const settingsRes = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { baseUrl: "http://127.0.0.1:9", apiKey: "sk-test", model: "m" },
    });
    expect(settingsRes.statusCode).toBe(200);
  });

  afterEach(async () => {
    await app.close();
    handle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const lessonIds = () =>
    handle.db.select().from(lessons).all().sort((a, b) => a.order - b.order);

  it("blocks the first entry into a lesson whose previous lesson is active", async () => {
    const [l1, l2] = lessonIds();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { lessonId: l2!.id },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("lesson_locked");
    expect(body.details).toContain("第 1 课");
  });

  it("lets the first lesson and already-entered lessons through", async () => {
    const [l1, l2] = lessonIds();

    // A lesson with an existing session is a revisit, not a first entry —
    // the gate only guards AI prep runs.
    const existing = insertSessionWithOpening(handle.db, l2!, "旧开场白");
    const reuse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { lessonId: l2!.id },
    });
    expect(reuse.statusCode).toBe(200);
    expect(reuse.json().id).toBe(existing.id);

    // Completing lesson 1 unlocks lesson 2's first entry: the request now
    // passes the gate and fails later at opening generation (no LLM at
    // 127.0.0.1:9) — opening_failed, NOT lesson_locked.
    handle.db.transaction((tx) => {
      markLessonCompleted(tx, l1!.id, "已掌握：KP 一");
    });
    const unlocked = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { lessonId: l1!.id },
    });
    expect(unlocked.statusCode).toBe(502);
    expect(unlocked.json().error).toBe("opening_failed");
  });

  it("exposes the gate state as the locked flag in the lessons list", async () => {
    const list = async () =>
      (
        await app.inject({ method: "GET", url: `/api/chunks/${chunkId}/lessons` })
      ).json();

    let body = await list();
    expect(body.lessons.map((l: { locked: boolean }) => l.locked)).toEqual([
      false,
      true,
    ]);

    const [l1] = lessonIds();
    handle.db.transaction((tx) => {
      markLessonCompleted(tx, l1!.id, "已掌握：KP 一");
    });
    body = await list();
    expect(body.lessons.map((l: { locked: boolean }) => l.locked)).toEqual([
      false,
      false,
    ]);
  });
});
