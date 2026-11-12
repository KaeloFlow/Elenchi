import { z } from "zod";
import type { Db } from "../db/client.js";
import { readPrepCheckpoint, savePrepCheckpoint } from "./task-store.js";
import { buildQualityResult, type QualityPreparedUnit } from "./quality-result.js";
import { PreparedKnowledgeSchema } from "./knowledge-preparation.js";
const ResultSchema = z.object({
  kps: z.array(z.object({ id: z.string(), statement: z.string(), type: PreparedKnowledgeSchema.shape.type, sectionIndex: z.number(), sectionTitle: z.string(), evidence: z.array(z.string()), conditions: z.array(z.string()), exceptions: z.array(z.string()) })),
  lessons: z.array(z.object({ lesson: z.object({ title: z.string(), objective: z.string(), kpIndices: z.array(z.number()), autoPacked: z.boolean() }), kpIds: z.array(z.string()) })),
  sourceCoverage: z.array(z.object({ start: z.number(), end: z.number() })),
}).strict();
export type StoredQualityResult = z.infer<typeof ResultSchema>;
export const RESULT_UNIT_KEY = "quality-result:v1";

/** Final aggregation is itself a fenced checkpoint, written before task success. */
export function persistQualityResult(db: Db, input: { taskId: string; generation: number; units: QualityPreparedUnit[]; sectionTitle: string; sourceHash: string }): boolean {
  const result = buildQualityResult(input.units, input.sectionTitle);
  return savePrepCheckpoint(db, { taskId: input.taskId, generation: input.generation,
    unitKey: RESULT_UNIT_KEY, inputHash: input.sourceHash, payload: result }, ResultSchema);
}
export function readQualityResult(db: Db, taskId: string, sourceHash: string): StoredQualityResult | undefined {
  return readPrepCheckpoint(db, taskId, RESULT_UNIT_KEY, sourceHash, ResultSchema);
}
