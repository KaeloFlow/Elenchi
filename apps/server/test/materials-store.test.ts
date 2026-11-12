import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "../src/db/client.js";
import {
  importMaterial,
  listMaterials,
  getMaterialChunks,
  deleteMaterialWithChunks,
} from "../src/materials/store.js";

describe("materials store", () => {
  let tmpDir: string;
  let handle: DbHandle;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-materials-"));
    handle = createDb(tmpDir);
    // Apply the schema directly for test isolation (no migration runner needed).
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
  });

  afterEach(() => {
    handle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports a material and stores one chunk row per heading", () => {
    const md = ["# 第一章", "内容一", "", "# 第二章", "内容二"].join("\n");

    const result = importMaterial(handle.db, "测试教材", "/tmp/test.md", md);

    expect(result.chunkCount).toBe(2);

    const chunks = getMaterialChunks(handle.db, result.id);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].title).toBe("第一章");
    expect(chunks[1].title).toBe("第二章");
    expect(chunks[0].order).toBeLessThan(chunks[1].order);
  });

  it("lists imported materials with their chunk count", () => {
    const md = ["# A", "a", "", "# B", "b", "", "# C", "c"].join("\n");
    importMaterial(handle.db, "三章教材", "/tmp/three.md", md);

    const list = listMaterials(handle.db);

    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("三章教材");
    expect(list[0].chunkCount).toBe(3);
  });

  it("rejects markdown that produces zero chunks", () => {
    expect(() =>
      importMaterial(handle.db, "空教材", "/tmp/empty.md", ""),
    ).toThrow(/为空/);
  });

  it("deleteMaterialWithChunks removes the material and its chunks but leaves others", () => {
    const md = ["# A", "a", "", "# B", "b"].join("\n");
    const first = importMaterial(handle.db, "教材一", "/tmp/one.md", md);
    const second = importMaterial(handle.db, "教材二", "/tmp/two.md", md);

    handle.db.transaction((tx) => deleteMaterialWithChunks(tx, first.id));

    expect(listMaterials(handle.db).map((m) => m.id)).toEqual([second.id]);
    expect(getMaterialChunks(handle.db, first.id)).toHaveLength(0);
    expect(getMaterialChunks(handle.db, second.id)).toHaveLength(2);
  });
});
