import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "../src/db/client.js";
import { sessionTurns } from "../src/db/schema.js";
import { importMaterial, getMaterialChunks } from "../src/materials/store.js";
import { insertSessionWithOpening } from "../src/dialogue/store.js";
import {
  defaultPedagogyState,
  type Assessment,
  type TeachingAction,
} from "../src/pedagogy/schemas.js";
import {
  getPedagogyState,
  recordTurnAndState,
  deletePedagogyForSessions,
} from "../src/pedagogy/store.js";

const SAMPLE_MD = "# 第一章 极限\n极限是微积分的基础概念。";

const ASSESSMENT: Assessment = {
  correctness: "incorrect",
  completeness: "missing_reasoning",
  reasoningQuality: "none",
  misconceptions: ["误解A"],
  userSignals: [],
  evidenceQuotes: ["原文"],
  coveredKpIds: [],
  focus: "焦点一",
};

const ACTION: TeachingAction = {
  actionType: "probe_assumption",
  hintLevel: 1,
  focus: "焦点一",
  evidenceQuotes: ["原文"],
  misconceptionTargets: ["误解A"],
};

describe("pedagogy store", () => {
  let tmpDir: string;
  let handle: DbHandle;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-pedagogy-"));
    handle = createDb(tmpDir);
    // Same inline-DDL pattern as dialogue-store.test.ts (plus the two new
    // pedagogy tables, mirroring the generated migration).
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

    const result = importMaterial(handle.db, "测试教材", "/tmp/test.md", SAMPLE_MD);
    const chunk = getMaterialChunks(handle.db, result.id)[0]!;
    // v3: sessions anchor to a lesson; the test DDL includes lessons tables
    // (see above), so create a minimal prep result and anchor to its lesson.
    const { insertPrepResults, getLessonById } = await import(
      "../src/prep/store.js"
    );
    insertPrepResults(handle.db, {
      chunkId: chunk.id,
      materialId: result.id,
      kps: [
        {
          statement: "极限是微积分的基础概念",
          type: "concept",
          sectionIndex: 0,
          sectionTitle: "章节导语",
          evidence: ["极限是微积分的基础概念。"],
        },
      ],
      lessons: [{ title: "第 1 课", objective: "理解极限", kpIndices: [0] }],
      partialSections: 0,
      autoPackedLessons: 0,
    });
    const lessonRow = handle.db
      .all(sql`SELECT id FROM lessons WHERE chunk_id = ${chunk.id}`)[0] as {
      id: string;
    };
    const lesson = getLessonById(handle.db, lessonRow.id)!;
    sessionId = insertSessionWithOpening(
      handle.db,
      lesson,
      "开场",
    ).id;
  });

  afterEach(() => {
    handle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the default state when no row exists", () => {
    expect(getPedagogyState(handle.db, sessionId)).toEqual(
      defaultPedagogyState(sessionId),
    );
  });

  it("inserts a turn and upserts the state row across two calls", () => {
    const first = { ...defaultPedagogyState(sessionId), hintLevel: 1 };
    handle.db.transaction((tx) => {
      recordTurnAndState(tx, sessionId, "u1", "a1", ASSESSMENT, ACTION, first);
    });
    expect(getPedagogyState(handle.db, sessionId).hintLevel).toBe(1);

    const second = { ...first, hintLevel: 2 };
    handle.db.transaction((tx) => {
      recordTurnAndState(tx, sessionId, "u2", "a2", ASSESSMENT, ACTION, second);
    });
    expect(getPedagogyState(handle.db, sessionId).hintLevel).toBe(2);

    const turns = handle.db.select().from(sessionTurns).all();
    expect(turns).toHaveLength(2);
    expect(JSON.parse(turns[0]!.assessment)).toMatchObject({
      correctness: "incorrect",
    });
    expect(JSON.parse(turns[0]!.action)).toMatchObject({
      actionType: "probe_assumption",
    });
  });

  it("cascades deletion for a set of session ids", () => {
    handle.db.transaction((tx) => {
      recordTurnAndState(
        tx,
        sessionId,
        "u1",
        "a1",
        ASSESSMENT,
        ACTION,
        defaultPedagogyState(sessionId),
      );
    });
    handle.db.transaction((tx) => {
      deletePedagogyForSessions(tx, [sessionId]);
    });
    expect(getPedagogyState(handle.db, sessionId)).toEqual(
      defaultPedagogyState(sessionId),
    );
    expect(handle.db.select().from(sessionTurns).all()).toHaveLength(0);
  });
});
