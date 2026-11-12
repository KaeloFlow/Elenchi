import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { createDb, type DbHandle } from "../src/db/client.js";
import { importMaterial, getMaterialChunks } from "../src/materials/store.js";
import {
  insertPrepResults,
  recordPrepFailure,
  getChunkPrep,
  listLessons,
  getLessonById,
  getLessonKps,
  countMasteredForLesson,
  markLessonCompleted,
  getCarryOutSummary,
  getMaterialProgress,
  updateMaterialProgress,
  getLessonLockState,
  deletePrepForMaterial,
} from "../src/prep/store.js";

describe("prep store", () => {
  let tmpDir: string;
  let handle: DbHandle;
  let materialId: string;
  let chunkId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-prep-"));
    // Apply all drizzle migrations to the fresh tmp database with raw
    // better-sqlite3 (same pattern as the routes tests), then open drizzle.
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
    const md = ["# 第1章 极限", "极限内容。"].join("\n");
    const result = importMaterial(handle.db, "测试教材", "/tmp/t.md", md);
    materialId = result.id;
    chunkId = getMaterialChunks(handle.db, materialId)[0]!.id;
  });

  afterEach(() => {
    handle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const kps = [
    {
      statement: "KP 一",
      type: "concept" as const,
      sectionIndex: 0,
      sectionTitle: "1.1",
      evidence: ["极限内容。"],
    },
    {
      statement: "KP 二",
      type: "principle" as const,
      sectionIndex: 0,
      sectionTitle: "1.1",
      evidence: ["极限内容。"],
    },
    {
      statement: "KP 三",
      type: "fact" as const,
      sectionIndex: 0,
      sectionTitle: "1.1",
      evidence: ["极限内容。"],
    },
  ];

  it("writes KPs + lessons + chunk_prep in one transaction and reads them back", () => {
    insertPrepResults(handle.db, {
      chunkId,
      materialId,
      kps,
      lessons: [
        {
          title: "第 1 课",
          objective: "学一和二",
          kpIndices: [0, 1],
          autoPacked: true,
        },
        {
          title: "第 2 课",
          objective: "学三",
          kpIndices: [2],
          autoPacked: false,
        },
      ],
      partialSections: 1,
      autoPackedLessons: 0,
    });

    const prep = getChunkPrep(handle.db, chunkId)!;
    expect(prep.status).toBe("ready");
    expect(prep.kpCount).toBe(3);
    expect(prep.lessonCount).toBe(2);
    expect(prep.partialSections).toBe(1);

    const lessonList = listLessons(handle.db, chunkId);
    expect(lessonList).toHaveLength(2);
    expect(lessonList[0]!.kpIds).toHaveLength(2);
    expect(lessonList[1]!.kpIds).toHaveLength(1);
    expect(lessonList[0]!.autoPacked).toBe(true);
    expect(lessonList[1]!.autoPacked).toBe(false);

    const lesson1 = getLessonById(handle.db, lessonList[0]!.id)!;
    const lessonKps = getLessonKps(handle.db, lesson1);
    expect(lessonKps.map((k) => k.statement)).toEqual(["KP 一", "KP 二"]);
    expect(lessonKps[0]!.type).toBe("concept");
  });

  it("retry deletes previous rows for the chunk (clean re-prep)", () => {
    insertPrepResults(handle.db, {
      chunkId,
      materialId,
      kps,
      lessons: [{ title: "旧课", objective: "旧目标", kpIndices: [0] }],
      partialSections: 0,
      autoPackedLessons: 0,
    });
    const oldLesson = listLessons(handle.db, chunkId)[0]!;

    insertPrepResults(handle.db, {
      chunkId,
      materialId,
      kps: [kps[0]!],
      lessons: [{ title: "新课", objective: "新目标", kpIndices: [0] }],
      partialSections: 0,
      autoPackedLessons: 0,
    });

    const lessonList = listLessons(handle.db, chunkId);
    expect(lessonList).toHaveLength(1);
    expect(lessonList[0]!.title).toBe("新课");
    expect(getLessonById(handle.db, oldLesson.id)).toBeUndefined();
    expect(getChunkPrep(handle.db, chunkId)!.kpCount).toBe(1);
  });

  it("records a failure and the failure row is retryable", () => {
    recordPrepFailure(handle.db, {
      chunkId,
      materialId,
      error: "抽取失败",
    });
    const prep = getChunkPrep(handle.db, chunkId)!;
    expect(prep.status).toBe("failed");
    expect(prep.error).toBe("抽取失败");
    expect(listLessons(handle.db, chunkId)).toHaveLength(0);
  });

  it("counts mastered KPs per lesson from material progress", () => {
    insertPrepResults(handle.db, {
      chunkId,
      materialId,
      kps,
      lessons: [{ title: "第 1 课", objective: "o", kpIndices: [0, 1, 2] }],
      partialSections: 0,
      autoPackedLessons: 0,
    });
    const lesson = listLessons(handle.db, chunkId)[0]!;
    expect(countMasteredForLesson(handle.db, lesson)).toBe(0);

    const allKpIds = getLessonKps(handle.db, lesson).map((k) => k.id);
    handle.db.transaction((tx) => {
      updateMaterialProgress(tx, materialId, [allKpIds[0]!], ["误解A"]);
    });
    expect(countMasteredForLesson(handle.db, lesson)).toBe(1);

    const progress = getMaterialProgress(handle.db, materialId);
    expect(progress.masteredKpIds).toEqual([allKpIds[0]]);
    expect(progress.openMisconceptions).toEqual(["误解A"]);
  });

  it("marks a lesson completed with the carry-out summary", () => {
    insertPrepResults(handle.db, {
      chunkId,
      materialId,
      kps,
      lessons: [
        { title: "第 1 课", objective: "o", kpIndices: [0] },
        { title: "第 2 课", objective: "o2", kpIndices: [1] },
      ],
      partialSections: 0,
      autoPackedLessons: 0,
    });
    const lesson1 = listLessons(handle.db, chunkId)[0]!;
    handle.db.transaction((tx) => {
      markLessonCompleted(tx, lesson1.id, "已掌握：KP 一；待检查：无");
    });

    const updated = getLessonById(handle.db, lesson1.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.carryOutSummary).toBe("已掌握：KP 一；待检查：无");
    expect(updated.completedAt).not.toBeNull();

    // Lesson 2's carry-in comes from lesson 1's carry-out.
    expect(getCarryOutSummary(handle.db, chunkId, 2)).toBe(
      "已掌握：KP 一；待检查：无",
    );
    expect(getCarryOutSummary(handle.db, chunkId, 1)).toBeNull();
  });

  it("lesson gate locks on an incomplete previous lesson only", () => {
    insertPrepResults(handle.db, {
      chunkId,
      materialId,
      kps,
      lessons: [
        { title: "第 1 课", objective: "o", kpIndices: [0] },
        { title: "第 2 课", objective: "o2", kpIndices: [1] },
        { title: "第 3 课", objective: "o3", kpIndices: [2] },
      ],
      partialSections: 0,
      autoPackedLessons: 0,
    });
    const [l1, l2, l3] = listLessons(handle.db, chunkId);

    // First lesson is never gated.
    expect(getLessonLockState(handle.db, l1!)).toEqual({
      locked: false,
      previousLessonTitle: null,
      previousLessonOrder: null,
    });
    // Later lessons locked while the previous is still active.
    expect(getLessonLockState(handle.db, l2!)).toEqual({
      locked: true,
      previousLessonTitle: "第 1 课",
      previousLessonOrder: 1,
    });

    handle.db.transaction((tx) => {
      markLessonCompleted(tx, l1!.id, "已掌握：KP 一");
    });
    expect(getLessonLockState(handle.db, l2!).locked).toBe(false);
    // Lesson 3 still gated by the active lesson 2.
    expect(getLessonLockState(handle.db, l3!).locked).toBe(true);
  });

  it("lesson gate fails open when the previous lesson row is missing", () => {
    insertPrepResults(handle.db, {
      chunkId,
      materialId,
      kps: [kps[0]!, kps[1]!],
      lessons: [{ title: "孤课", objective: "o", kpIndices: [0, 1] }],
      partialSections: 0,
      autoPackedLessons: 0,
    });
    // order 1 with no predecessors at all.
    const lone = listLessons(handle.db, chunkId)[0]!;
    expect(getLessonLockState(handle.db, lone).locked).toBe(false);
  });

  it("deletePrepForMaterial removes all prep rows for the material", () => {
    insertPrepResults(handle.db, {
      chunkId,
      materialId,
      kps,
      lessons: [{ title: "第 1 课", objective: "o", kpIndices: [0] }],
      partialSections: 0,
      autoPackedLessons: 0,
    });
    handle.db.transaction((tx) => {
      updateMaterialProgress(tx, materialId, [], []);
      deletePrepForMaterial(tx, materialId);
    });
    expect(getChunkPrep(handle.db, chunkId)).toBeUndefined();
    expect(listLessons(handle.db, chunkId)).toHaveLength(0);
    expect(getMaterialProgress(handle.db, materialId).masteredKpIds).toEqual([]);
  });
});
