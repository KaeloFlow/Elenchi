import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolveServerConfig } from "../config.js";

const config = resolveServerConfig();
const dbPath = path.join(config.dataDir, "elenchi.sqlite3");
const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

migrate(db, { migrationsFolder: path.resolve("drizzle") });

// eslint-disable-next-line no-console
console.log(`Migrations applied to ${dbPath}`);
sqlite.close();
