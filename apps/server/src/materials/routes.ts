import type { FastifyInstance } from "fastify";
import {
  MaterialSummarySchema,
  MaterialChunkSchema,
  ImportMaterialResponseSchema,
} from "@elenchi/shared";
import type { Db } from "../db/client.js";
import {
  importMaterial,
  listMaterials,
  getMaterialChunks,
  getMaterialTitle,
  deleteMaterialWithChunks,
} from "./store.js";
import { deleteSessionsAndMessages } from "../dialogue/store.js";
import { deleteFlashcardsForSessions } from "../flashcards/store.js";
import { deletePedagogyForSessions } from "../pedagogy/store.js";
import { deletePrepForMaterial } from "../prep/store.js";

const MAX_MATERIAL_BYTES = 5 * 1024 * 1024; // 5MB, generous for a markdown textbook

export function registerMaterialsRoutes(
  app: FastifyInstance,
  db: Db,
): void {
  app.get("/api/materials", async () => {
    const list = listMaterials(db);
    return list.map((m) => MaterialSummarySchema.parse(m));
  });

  app.get("/api/materials/:id/chunks", async (request, reply) => {
    const { id } = request.params as { id: string };
    const chunks = getMaterialChunks(db, id);
    if (chunks.length === 0) {
      reply.code(404);
      return { error: "material_not_found" };
    }
    return chunks.map((c) => MaterialChunkSchema.parse(c));
  });

  app.post("/api/materials", async (request, reply) => {
    const data = await request.file({
      limits: { fileSize: MAX_MATERIAL_BYTES },
    });

    if (!data) {
      reply.code(400);
      return { error: "no_file_uploaded" };
    }
    if (!data.filename.toLowerCase().endsWith(".md")) {
      reply.code(400);
      return { error: "unsupported_file_type", details: "仅支持 .md 文件" };
    }

    const buffer = await data.toBuffer();
    const source = buffer.toString("utf-8");
    const title = data.filename.replace(/\.md$/i, "");

    try {
      const result = importMaterial(db, title, data.filename, source);
      reply.code(201);
      return ImportMaterialResponseSchema.parse(result);
    } catch (err) {
      reply.code(400);
      return {
        error: "import_failed",
        details: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.delete("/api/materials/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getMaterialTitle(db, id)) {
      reply.code(404);
      return { error: "material_not_found" };
    }

    // No foreign keys in db/schema.ts, so the cascade is explicit and
    // atomic: sessions+messages first (collecting sessionIds), then
    // flashcards by those ids, pedagogy rows, then prep rows and
    // chunks+material. Composed here in the routes layer because
    // materials/store.ts cannot depend on the dialogue and flashcards
    // stores without creating a dependency cycle. Any future table
    // referencing sessions or materials must extend this transaction.
    db.transaction((tx) => {
      const sessionIds = deleteSessionsAndMessages(tx, id);
      deletePedagogyForSessions(tx, sessionIds);
      deleteFlashcardsForSessions(tx, sessionIds);
      deletePrepForMaterial(tx, id);
      deleteMaterialWithChunks(tx, id);
    });

    reply.code(204);
    return null;
  });
}
