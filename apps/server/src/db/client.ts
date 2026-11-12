import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

/**
 * Native module boundary: better-sqlite3 must only be referenced from this
 * file (see design spec #6, constraint 5) so future electron-rebuild only
 * touches this module.
 */
export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * A live transaction handle from Db#transaction. Query-compatible with Db
 * (a DbTx is assignable to Db-typed parameters), so store functions can be
 * reused inside a caller-owned transaction; the converse is intentionally
 * not true. Native module boundary note: this stays a type-only export —
 * better-sqlite3 itself is still referenced only from this file.
 */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface DbHandle {
  db: Db;
  /** Closes the underlying native SQLite connection (releases the file lock). */
  close: () => void;
}

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export interface CreateDbOptions {
  /** Apply bundled migrations for a service-owned database. */
  migrate?: boolean;
}

function hasTable(sqlite: Database.Database, name: string): boolean {
  return Boolean(
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

function hasColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
): boolean {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .some((item) => item.name === column);
}

/**
 * Some early/manual installations own the complete SQL schema but predate
 * Drizzle's journal. Establish a journal baseline from the schema's highest
 * safely identifiable migration, then let Drizzle apply only the remainder.
 * This replaces the old unsafe "materials exists => skip all migrations"
 * guard: it never replays old DDL, but still upgrades a pre-v3 schema to 0005.
 */
function bootstrapLegacyMigrationJournal(sqlite: Database.Database): void {
  if (hasTable(sqlite, "__drizzle_migrations") || !hasTable(sqlite, "materials")) {
    return;
  }

  let baseline = 1789408239750; // 0000: materials/settings/flashcards
  if (hasTable(sqlite, "material_chunks")) baseline = 1789446493783; // 0001
  if (hasColumn(sqlite, "sessions", "chunk_id")) baseline = 1789452121036; // 0002
  if (
    hasTable(sqlite, "session_pedagogy_state") &&
    hasTable(sqlite, "session_turns")
  ) baseline = 1789637096728; // 0004 (0003 is data-only)
  if (
    hasTable(sqlite, "knowledge_points") &&
    hasTable(sqlite, "lessons") &&
    hasTable(sqlite, "chunk_prep") &&
    hasTable(sqlite, "material_progress") &&
    hasColumn(sqlite, "sessions", "lesson_id")
  ) baseline = 1789653214542; // 0005

  sqlite.exec(`
    CREATE TABLE "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    );
  `);
  sqlite
    .prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    )
    .run("legacy-schema-bootstrap", baseline);
}

export function createDb(
  dataDir: string,
  options: CreateDbOptions = {},
): DbHandle {
  const dbPath = path.join(dataDir, "elenchi.sqlite3");
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });

  if (options.migrate) {
    bootstrapLegacyMigrationJournal(sqlite);
    // Drizzle's journal is now the sole migration authority. The one-time
    // legacy bootstrap above only gives pre-journal schemas their safe start.
    migrate(db, { migrationsFolder });
  }

  return {
    db,
    close: () => sqlite.close(),
  };
}
