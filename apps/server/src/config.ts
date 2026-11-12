import path from "node:path";
import fs from "node:fs";

/**
 * Resolves runtime configuration for the Elenchi server.
 *
 * Architecture constraint:
 * - data directory must be injectable (ELENCHI_DATA_DIR), never hardcoded
 * - port must be dynamically allocated by default, never hardcoded
 */
export interface ServerConfig {
  /** Absolute path to the local data directory (SQLite db, materials, exports). */
  dataDir: string;
  /** Preferred port. 0 means "let the OS pick a free port". */
  port: number;
  /** Host to bind to. */
  host: string;
  /** Optional built web directory served at the root route. */
  webDistDir?: string;
}

export interface ServerConfigOverrides {
  dataDir?: string;
  port?: number;
  host?: string;
  webDistDir?: string;
}

export function resolveServerConfig(
  overrides: ServerConfigOverrides = {},
): ServerConfig {
  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.ELENCHI_DATA_DIR ?? "./data",
  );

  const portFromEnv = process.env.ELENCHI_PORT
    ? Number.parseInt(process.env.ELENCHI_PORT, 10)
    : undefined;

  const port = overrides.port ?? portFromEnv ?? 0;
  const host = overrides.host ?? process.env.ELENCHI_HOST ?? "127.0.0.1";
  const webDistDir = overrides.webDistDir ?? process.env.ELENCHI_WEB_DIST;

  fs.mkdirSync(dataDir, { recursive: true });

  return { dataDir, port, host, webDistDir };
}
