import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { getSession, listMessages } from "../dialogue/store.js";
import { getMaterialTitle, getChunkById } from "../materials/store.js";
import { renderTranscriptMarkdown } from "./markdown.js";

export function registerExportRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/sessions/:id/export.md", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(db, id);
    if (!session) {
      reply.code(404);
      return { error: "session_not_found" };
    }

    const chunk = getChunkById(db, session.chunkId);
    if (!chunk) {
      reply.code(404);
      return { error: "chunk_not_found" };
    }
    const materialTitle = getMaterialTitle(db, session.materialId) ?? "未命名教材";
    const messages = listMessages(db, id);

    const markdown = renderTranscriptMarkdown({
      materialTitle,
      chunkTitle: chunk.title,
      startedAt: session.startedAt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });

    reply
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="transcript-${id}.md"`,
      );
    return markdown;
  });
}
