import type { FastifyInstance } from "fastify";
import {
  UpdateLlmSettingsInputSchema,
  LlmSettingsResponseSchema,
  TestConnectionInputSchema,
  TestConnectionResultSchema,
} from "@elenchi/shared";
import { readSettings, writeSettings, maskApiKey, type LlmSettings } from "./store.js";
import { testLlmConnection } from "./client.js";
import type { ServerConfig } from "../config.js";

function toResponse(settings: ReturnType<typeof readSettings>) {
  return LlmSettingsResponseSchema.parse({
    configured: settings !== null,
    baseUrl: settings?.baseUrl ?? null,
    apiKeyPreview: settings ? maskApiKey(settings.apiKey) : null,
    model: settings?.model ?? null,
  });
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  config: ServerConfig,
): void {
  app.get("/api/settings", async () => {
    return toResponse(readSettings(config.dataDir));
  });

  app.put("/api/settings", async (request, reply) => {
    const parseResult = UpdateLlmSettingsInputSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400);
      return { error: "invalid_input", details: parseResult.error.flatten() };
    }

    const input = parseResult.data;
    let full: LlmSettings;
    if (input.apiKey !== undefined) {
      full = { baseUrl: input.baseUrl, apiKey: input.apiKey, model: input.model };
    } else {
      // apiKey omitted: keep the stored key. The client never sees the
      // plaintext key back (only apiKeyPreview), so editing model/baseUrl
      // without re-entering the key must be a server-side concern.
      const existing = readSettings(config.dataDir);
      if (!existing) {
        reply.code(400);
        return { error: "api_key_required" };
      }
      full = {
        baseUrl: input.baseUrl,
        apiKey: existing.apiKey,
        model: input.model,
      };
    }

    writeSettings(config.dataDir, full);
    return toResponse(readSettings(config.dataDir));
  });

  app.post("/api/settings/test-connection", async (request, reply) => {
    const parseResult = TestConnectionInputSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400);
      return { error: "invalid_input", details: parseResult.error.flatten() };
    }
    const outcome = await testLlmConnection(
      parseResult.data.baseUrl,
      parseResult.data.apiKey,
    );
    return TestConnectionResultSchema.parse(outcome);
  });
}
