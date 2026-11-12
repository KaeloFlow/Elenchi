import { z } from "zod";

export const MaterialSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  chunkCount: z.number(),
  createdAt: z.number(),
});
export type MaterialSummary = z.infer<typeof MaterialSummarySchema>;

export const MaterialChunkSchema = z.object({
  id: z.string(),
  order: z.number(),
  title: z.string(),
  level: z.number(),
  content: z.string(),
});
export type MaterialChunkDto = z.infer<typeof MaterialChunkSchema>;

export const ImportMaterialResponseSchema = z.object({
  id: z.string(),
  chunkCount: z.number(),
});
export type ImportMaterialResponse = z.infer<
  typeof ImportMaterialResponseSchema
>;
