import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { resolveServerConfig, type ServerConfigOverrides } from "./config.js";

export interface StartedServer {
  url: string;
  port: number;
  dataDir: string;
  close: () => Promise<void>;
}

/**
 * Single entry point used by both the CLI launcher and (in a future phase)
 * an Electron main process. See design spec #6, constraint 4.
 */
export async function startServer(
  overrides: ServerConfigOverrides = {},
): Promise<StartedServer> {
  const config = resolveServerConfig(overrides);
  const { db, close: closeDb } = createDb(config.dataDir, { migrate: true });
  const app = await buildApp(config, db);

  const address = await app.listen({ port: config.port, host: config.host });
  const actualPort = (app.server.address() as { port: number }).port;

  return {
    url: address,
    port: actualPort,
    dataDir: config.dataDir,
    close: async () => {
      await app.close();
      closeDb();
    },
  };
}
