import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "../src/db/client.js";
import { sessionTurns } from "../src/db/schema.js";
import { importMaterial, getMaterialChunks } from "../src/materials/store.js";
import {
  findSessionByLessonId,
  getSession,
  listMessages,
  appendExchange,
  deleteSessionsAndMessages,
  insertSessionWithOpening,
} from "../src/dialogue/store.js";
import { defaultPedagogyState } from "../src/pedagogy/schemas.js";
import {
  getPedagogyState,
  recordTurnAndState,
} from "../src/pedagogy/store.js";
import {
  insertPrepResults,
  getLessonById,
  type KpInput,
} from "../src/prep/store.js";

describe("dialogue store", () => {
  let tmpDir: string;
  let handle: DbHandle;
  let chunkId: string;
  let lessonId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-dialogue-"));
    handle = createDb(tmpDir);
    handle.db.run(sql`
      CREATE TABLE materials (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    handle.db.run(sql`
      CREATE TABLE material_chunks (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL,
        "order" INTEGER NOT NULL,
        title TEXT NOT NULL,
        level INTEGER NOT NULL,
        content TEXT NOT NULL
      );
    `);
    handle.db.run(sql`
      CREATE TABLE knowledge_points (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        "order" INTEGER NOT NULL,
        statement TEXT NOT NULL,
        type TEXT NOT NULL,
        section_index INTEGER NOT NULL,
        section_title TEXT NOT NULL,
        evidence TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    handle.db.run(sql`
      CREATE TABLE lessons (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        "order" INTEGER NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        kp_ids TEXT NOT NULL,
        carry_out_summary TEXT,
        auto_packed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        completed_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    handle.db.run(sql`
      CREATE TABLE chunk_prep (
        chunk_id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL,
        status TEXT NOT NULL,
        kp_count INTEGER NOT NULL,
        lesson_count INTEGER NOT NULL,
        partial_sections INTEGER NOT NULL DEFAULT 0,
        auto_packed_lessons INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        prepared_at INTEGER NOT NULL
      );
    `);
    handle.db.run(sql`
      CREATE TABLE lesson_card_versions (
        version TEXT PRIMARY KEY,
        lesson_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        learner_version TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        payload TEXT NOT NULL,
        published_at INTEGER NOT NULL
      );
    `);
    handle.db.run(sql`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        lesson_id TEXT,
        card_version TEXT,
        started_at INTEGER NOT NULL
      );
    `);
    handle.db.run(sql`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    handle.db.run(sql`
      CREATE TABLE session_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        assessment TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    handle.db.run(sql`
      CREATE TABLE session_pedagogy_state (
        session_id TEXT PRIMARY KEY,
        hint_level INTEGER NOT NULL DEFAULT 0,
        stuck_counter INTEGER NOT NULL DEFAULT 0,
        consecutive_no_coverage INTEGER NOT NULL DEFAULT 0,
        turns_on_focus INTEGER NOT NULL DEFAULT 0,
        current_focus TEXT,
        misconceptions TEXT NOT NULL DEFAULT '[]',
        covered_points TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
    `);

    const md = ["# 第一章 极限", "极限是微积分的基础概念。"].join("\n");
    const result = importMaterial(handle.db, "测试教材", "/tmp/test.md", md);
    chunkId = getMaterialChunks(handle.db, result.id)[0]!.id;
    const kps: KpInput[] = [
      {
        statement: "极限是微积分的基础概念",
        type: "concept",
        sectionIndex: 0,
        sectionTitle: "章节导语",
        evidence: ["极限是微积分的基础概念。"],
      },
    ];
    insertPrepResults(handle.db, {
      chunkId,
      materialId: result.id,
      kps,
      lessons: [{ title: "第 1 课", objective: "理解极限", kpIndices: [0] }],
      partialSections: 0,
      autoPackedLessons: 0,
    });
    lessonId = getLessonById(handle.db, listLessonsId(handle.db, chunkId))!.id;
  });

  afterEach(() => {
    handle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function listLessonsId(db: DbHandle["db"], chunk: string): string {
    // listLessons returns records; here we only need the single lesson id.
    const rows = db.all(sql`SELECT id FROM lessons WHERE chunk_id = ${chunk}`);
    return (rows[0] as { id: string }).id;
  }

  it("creates a session anchored to the given lesson", () => {
    const lesson = getLessonById(handle.db, lessonId)!;
    insertSessionWithOpening(handle.db, lesson, "开场消息");
    const found = findSessionByLessonId(handle.db, lessonId)!;
    expect(found.chunkId).toBe(chunkId);
    expect(found.lessonId).toBe(lessonId);
    expect(found.materialId).toBeTruthy();
    expect(listMessages(handle.db, found.id)).toHaveLength(1);
  });

  it("findSessionByLessonId returns undefined before creation and the session after", () => {
    expect(findSessionByLessonId(handle.db, lessonId)).toBeUndefined();
    const lesson = getLessonById(handle.db, lessonId)!;
    const first = insertSessionWithOpening(handle.db, lesson, "开场一");
    const second = findSessionByLessonId(handle.db, lessonId)!;
    expect(second.id).toBe(first.id);
  });

  it("getSession returns undefined for an unknown session id", () => {
    expect(getSession(handle.db, "does-not-exist")).toBeUndefined();
  });

  it("appendExchange persists the pair in order with a 1ms createdAt gap", () => {
    const lesson = getLessonById(handle.db, lessonId)!;
    const session = insertSessionWithOpening(handle.db, lesson, "开场");
    const saved = appendExchange(
      handle.db,
      session.id,
      "0.999... 不可能等于 1 吧",
      "先别急。⅓ × 3 等于多少？",
    );

    // history = opening + the new pair
    const history = listMessages(handle.db, session.id).slice(-2);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject(saved.user);
    expect(history[1]).toMatchObject(saved.assistant);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
    expect(history[1].createdAt).toBe(history[0].createdAt + 1);
  });

  it("insertSessionWithOpening persists the session and the tutor opening atomically", () => {
    const lesson = getLessonById(handle.db, lessonId)!;
    const session = insertSessionWithOpening(handle.db, lesson, "开场消息");
    const history = listMessages(handle.db, session.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: "assistant", content: "开场消息" });
    expect(session.lessonId).toBe(lessonId);
  });

  it("appendExchange runs the onPersisted hook inside the transaction with saved ids", () => {
    const lesson = getLessonById(handle.db, lessonId)!;
    const session = insertSessionWithOpening(handle.db, lesson, "开场");
    const saved = appendExchange(
      handle.db,
      session.id,
      "问题",
      "回答",
      (tx, s) => {
        // The hook runs in-transaction and can write DB rows: composed with
        // the pedagogy store here to verify the cross-store transaction path.
        recordTurnAndState(
          tx,
          session.id,
          s.user.id,
          s.assistant.id,
          {
            correctness: "correct",
            completeness: "complete",
            reasoningQuality: "sound",
            misconceptions: [],
            userSignals: [],
            evidenceQuotes: [],
            coveredKpIds: ["kp-1"],
            focus: null,
          },
          {
            actionType: "summarize",
            hintLevel: 0,
            focus: null,
            evidenceQuotes: [],
            misconceptionTargets: [],
          },
          { ...defaultPedagogyState(session.id), masteredKpIds: ["kp-1"] },
        );
      },
    );

    const state = getPedagogyState(handle.db, session.id);
    expect(state.masteredKpIds).toEqual(["kp-1"]);
    const turns = handle.db.select().from(sessionTurns).all();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userMessageId).toBe(saved.user.id);
    expect(turns[0]!.assistantMessageId).toBe(saved.assistant.id);
  });

  it("deleteSessionsAndMessages removes sessions and messages of the material and returns the ids", () => {
    const mdA = ["# A", "a"].join("\n");
    const mdB = ["# B", "b"].join("\n");
    const materialA = importMaterial(handle.db, "教材A", "/tmp/a.md", mdA);
    const materialB = importMaterial(handle.db, "教材B", "/tmp/b.md", mdB);
    const chunkA = getMaterialChunks(handle.db, materialA.id)[0]!.id;
    const chunkB = getMaterialChunks(handle.db, materialB.id)[0]!.id;
    // Lessons for both materials so sessions can anchor to them.
    insertPrepResults(handle.db, {
      chunkId: chunkA,
      materialId: materialA.id,
      kps: [
        {
          statement: "KA",
          type: "fact",
          sectionIndex: 0,
          sectionTitle: "s",
          evidence: ["a"],
        },
      ],
      lessons: [{ title: "L-A", objective: "o", kpIndices: [0] }],
      partialSections: 0,
      autoPackedLessons: 0,
    });
    insertPrepResults(handle.db, {
      chunkId: chunkB,
      materialId: materialB.id,
      kps: [
        {
          statement: "KB",
          type: "fact",
          sectionIndex: 0,
          sectionTitle: "s",
          evidence: ["b"],
        },
      ],
      lessons: [{ title: "L-B", objective: "o", kpIndices: [0] }],
      partialSections: 0,
      autoPackedLessons: 0,
    });
    const lessonA = getLessonById(
      handle.db,
      listLessonsId(handle.db, chunkA),
    )!;
    const lessonB = getLessonById(
      handle.db,
      listLessonsId(handle.db, chunkB),
    )!;
    const sessionA = insertSessionWithOpening(handle.db, lessonA, "开场A");
    const sessionB = insertSessionWithOpening(handle.db, lessonB, "开场B");
    appendExchange(handle.db, sessionA.id, "q1", "a1");
    appendExchange(handle.db, sessionB.id, "q2", "a2");

    const deleted = handle.db.transaction((tx) =>
      deleteSessionsAndMessages(tx, materialA.id),
    );

    expect(deleted).toEqual([sessionA.id]);
    expect(listMessages(handle.db, sessionA.id)).toHaveLength(0);
    expect(getSession(handle.db, sessionA.id)).toBeUndefined();
    expect(getSession(handle.db, sessionB.id)).toBeDefined();
    expect(listMessages(handle.db, sessionB.id)).toHaveLength(3); // opening + pair
  });
});
