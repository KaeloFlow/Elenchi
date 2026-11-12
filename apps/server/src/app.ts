import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { HealthResponseSchema } from "@elenchi/shared";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { registerSettingsRoutes } from "./settings/routes.js";
import { registerMaterialsRoutes } from "./materials/routes.js";
import { registerDialogueRoutes } from "./dialogue/routes.js";
import { registerFlashcardsRoutes } from "./flashcards/routes.js";
import { registerExportRoutes } from "./export/routes.js";
import { registerPrepRoutes } from "./prep/routes.js";
import { registerQualityPrepRoutes } from "./prep/quality-routes.js";

export async function buildApp(
  config: ServerConfig,
  db: Db,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(multipart);
  if (config.webDistDir) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      wildcard: false,
    });
  }

  app.get("/api/health", async () => {
    const payload = HealthResponseSchema.parse({
      status: "ok",
      version: "0.1.0",
      dataDir: config.dataDir,
    });
    return payload;
  });

  registerSettingsRoutes(app, config);
  registerMaterialsRoutes(app, db);
  registerPrepRoutes(app, db, config);
  registerQualityPrepRoutes(app, db, config);
  registerDialogueRoutes(app, db, config);
  registerFlashcardsRoutes(app, db, config);
  registerExportRoutes(app, db);

  return app;
}
