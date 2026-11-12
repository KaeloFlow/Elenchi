import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { startServer } from "../src/server.js";

describe("service migration bootstrap", () => {
  it("upgrades a journaled pre-v3 database through pending bundled migrations", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-upgrade-"));
    const dbPath = path.join(dataDir, "elenchi.sqlite3");
    const sqlite = new Database(dbPath);
    try {
      const migrationsDir = path.resolve("drizzle");
      for (const file of fs
        .readdirSync(migrationsDir)
        .filter((name) => name.endsWith(".sql") && name < "0005")
        .sort()) {
        sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
      }
      sqlite.exec(`
        CREATE TABLE "__drizzle_migrations" (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric
        );
      `);
      // Drizzle chooses pending migrations by journal timestamp. Mimic an
      // actual v2 installation that applied 0000–0004 before v3 existed.
      sqlite
        .prepare(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
        )
        .run("v2-fixture", 1789637096728);
      sqlite
        .prepare(
          "INSERT INTO materials (id, title, source_path, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("material-v2", "升级前教材", "/tmp/old.md", Date.now());
      sqlite
        .prepare(
          "INSERT INTO material_chunks (id, material_id, \"order\", title, level, content) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("chunk-v2", "material-v2", 1, "第一章", 1, "旧章节内容");
      sqlite
        .prepare(
          "INSERT INTO sessions (id, material_id, started_at, chunk_id) VALUES (?, ?, ?, ?)",
        )
        .run("session-v2", "material-v2", Date.now(), "chunk-v2");
    } finally {
      sqlite.close();
    }

    const server = await startServer({ dataDir, port: 0 });
    await server.close();

    const upgraded = new Database(dbPath, { readonly: true });
    try {
      const names = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(names).toEqual(
        expect.arrayContaining([
          "knowledge_points",
          "lessons",
          "chunk_prep",
          "material_progress",
        ]),
      );
      const sessionColumns = upgraded.prepare("PRAGMA table_info(sessions)").all();
      expect(sessionColumns).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "lesson_id" })]),
      );
      expect(
        upgraded.prepare("SELECT title FROM materials WHERE id = ?").get("material-v2"),
      ).toEqual(expect.objectContaining({ title: "升级前教材" }));
      expect(
        upgraded.prepare("SELECT chunk_id FROM sessions WHERE id = ?").get("session-v2"),
      ).toEqual(expect.objectContaining({ chunk_id: "chunk-v2" }));
    } finally {
      upgraded.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
