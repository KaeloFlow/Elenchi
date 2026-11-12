import { randomUUID } from "node:crypto";
import { eq, asc } from "drizzle-orm";
import type { Db, DbTx } from "../db/client.js";
import { materials, materialChunks } from "../db/schema.js";
import { chunkMarkdown } from "./chunker.js";

export interface MaterialSummary {
  id: string;
  title: string;
  chunkCount: number;
  createdAt: number;
}

export interface MaterialChunkRecord {
  id: string;
  order: number;
  title: string;
  level: number;
  content: string;
}

/**
 * A chunk record including its owning materialId. Distinct from
 * MaterialChunkRecord because the dialogue module (stage 3) needs the
 * materialId to create a session, while the per-material chunk list (used
 * by getMaterialChunks) already scopes to one materialId and doesn't repeat it.
 */
export interface MaterialChunkWithMaterialId extends MaterialChunkRecord {
  materialId: string;
}

/**
 * Sole owner of materials/material_chunks persistence. Parses markdown via
 * chunker.ts, stores the material row plus one row per chunk in a single
 * transaction.
 */
export function importMaterial(
  db: Db,
  title: string,
  sourcePath: string,
  markdownSource: string,
): { id: string; chunkCount: number } {
  const chunks = chunkMarkdown(markdownSource);
  if (chunks.length === 0) {
    throw new Error("教材内容为空，无法解析出任何章节");
  }

  const materialId = randomUUID();
  const createdAt = new Date();

  db.transaction((tx) => {
    tx.insert(materials)
      .values({ id: materialId, title, sourcePath, createdAt })
      .run();

    for (const chunk of chunks) {
      tx.insert(materialChunks)
        .values({
          id: randomUUID(),
          materialId,
          order: chunk.order,
          title: chunk.title,
          level: chunk.level,
          content: chunk.content,
        })
        .run();
    }
  });

  return { id: materialId, chunkCount: chunks.length };
}

export function listMaterials(db: Db): MaterialSummary[] {
  const rows = db.select().from(materials).all();
  return rows.map((row) => {
    const count = db
      .select()
      .from(materialChunks)
      .where(eq(materialChunks.materialId, row.id))
      .all().length;
    return {
      id: row.id,
      title: row.title,
      chunkCount: count,
      createdAt: row.createdAt.getTime(),
    };
  });
}

/**
 * Looks up a single material's title by id. Used by dialogue/routes.ts to
 * build the system prompt's `materialTitle`.
 */
export function getMaterialTitle(db: Db, materialId: string): string | undefined {
  const row = db.select().from(materials).where(eq(materials.id, materialId)).get();
  return row?.title;
}

export function getMaterialChunks(
  db: Db,
  materialId: string,
): MaterialChunkRecord[] {
  return db
    .select()
    .from(materialChunks)
    .where(eq(materialChunks.materialId, materialId))
    .orderBy(asc(materialChunks.order))
    .all();
}

/**
 * Looks up a single chunk by id regardless of which material it belongs to.
 * Used by dialogue/store.ts to resolve the materialId + content needed to
 * create or validate a session (dialogue owns sessions/messages, not chunks;
 * this getter is the read-only seam between the two modules).
 */
export function getChunkById(
  db: Db,
  chunkId: string,
): MaterialChunkWithMaterialId | undefined {
  const row = db
    .select()
    .from(materialChunks)
    .where(eq(materialChunks.id, chunkId))
    .get();
  return row;
}

/**
 * Deletes a material row and all its chunk rows. Chunk-first so the
 * material never briefly exists without its children inside the caller's
 * transaction. Runs on a caller-owned transaction: materials/routes.ts
 * composes the full cascade (sessions → messages, flashcards, then this);
 * doing it here would force this module to depend on dialogue/flashcards
 * stores and create a dependency cycle (dialogue/store.ts already imports
 * getChunkById from here).
 */
export function deleteMaterialWithChunks(tx: DbTx, materialId: string): void {
  tx.delete(materialChunks).where(eq(materialChunks.materialId, materialId)).run();
  tx.delete(materials).where(eq(materials.id, materialId)).run();
}
