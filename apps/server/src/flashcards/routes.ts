import type { FastifyInstance } from "fastify";
import {
  FlashcardSchema,
  GenerateFlashcardsResponseSchema,
  UpdateFlashcardInputSchema,
} from "@elenchi/shared";
import type { Db } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import { readSettings } from "../settings/store.js";
import { getMaterialTitle, getChunkById } from "../materials/store.js";
import { getSession, listMessages } from "../dialogue/store.js";
import {
  insertFlashcards,
  listFlashcards,
  updateFlashcard,
  deleteFlashcard,
} from "./store.js";
import { extractFlashcards } from "./generator.js";

export function registerFlashcardsRoutes(
  app: FastifyInstance,
  db: Db,
  config: ServerConfig,
): void {
  app.post("/api/sessions/:id/flashcards/generate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(db, id);
    if (!session) {
      reply.code(404);
      return { error: "session_not_found" };
    }

    const settings = readSettings(config.dataDir);
    if (!settings) {
      reply.code(400);
      return { error: "llm_not_configured" };
    }

    const chunk = getChunkById(db, session.chunkId);
    if (!chunk) {
      reply.code(404);
      return { error: "chunk_not_found" };
    }
    const materialTitle = getMaterialTitle(db, session.materialId) ?? "未命名教材";
    const history = listMessages(db, id);

    if (history.length === 0) {
      reply.code(400);
      return { error: "no_dialogue_history" };
    }

    try {
      const extracted = await extractFlashcards({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        context: {
          materialTitle,
          chunkTitle: chunk.title,
          history: history.map((m) => ({ role: m.role, content: m.content })),
        },
      });

      if (extracted.length === 0) {
        return GenerateFlashcardsResponseSchema.parse({ flashcards: [] });
      }

      const saved = insertFlashcards(db, id, extracted);
      return GenerateFlashcardsResponseSchema.parse({
        flashcards: saved.map((c) => FlashcardSchema.parse(c)),
      });
    } catch (err) {
      reply.code(502);
      return {
        error: "extraction_failed",
        details: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.get("/api/sessions/:id/flashcards", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(db, id);
    if (!session) {
      reply.code(404);
      return { error: "session_not_found" };
    }
    return listFlashcards(db, id).map((c) => FlashcardSchema.parse(c));
  });

  app.put("/api/flashcards/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parseResult = UpdateFlashcardInputSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400);
      return { error: "invalid_input", details: parseResult.error.flatten() };
    }

    const updated = updateFlashcard(db, id, parseResult.data);
    if (!updated) {
      reply.code(404);
      return { error: "flashcard_not_found" };
    }
    return FlashcardSchema.parse(updated);
  });

  app.delete("/api/flashcards/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = deleteFlashcard(db, id);
    if (!deleted) {
      reply.code(404);
      return { error: "flashcard_not_found" };
    }
    reply.code(204);
    return null;
  });
}
