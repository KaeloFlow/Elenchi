import { z } from "zod";
import { TeachingCardSchema, type TeachingCard } from "@elenchi/shared";
import type { Db } from "../db/client.js";
import { readPrepCheckpoint, savePrepCheckpoint } from "./task-store.js";
import { buildTeachingCard } from "./card-builder.js";
import type { StoredQualityResult } from "./quality-result-store.js";

const CandidateCardsSchema = z.array(TeachingCardSchema).min(1);
export const CANDIDATE_CARDS_KEY = "quality-cards:v1";

/** Builds auditable candidates only; publication remains exclusively publication.ts after review. */
export function persistCandidateCards(db: Db, input: { taskId: string; generation: number; sourceHash: string; source: string; rulesVersion: string; learnerVersion: string; result: StoredQualityResult }): boolean {
  const cards = input.result.lessons.map(({ lesson, kpIds }, index) => {
    const knowledge = kpIds.map((id) => {
      const kp = input.result.kps.find((candidate) => candidate.id === id);
      if (!kp) throw new Error("candidate_card_unknown_kp");
      return kp;
    });
    // This stable ID is intentionally allocated before persistence: semantic review
    // binds the same payload that will later be materialized as a real lesson.
    const lessonId = `quality-lesson:${input.taskId}:${index + 1}`;
    return buildTeachingCard({ version: `quality-card:${input.taskId}:${index + 1}`, lessonId,
      source: input.source, rulesVersion: input.rulesVersion, learnerVersion: input.learnerVersion,
      objective: lesson.objective, knowledge });
  });
  return savePrepCheckpoint(db, { taskId: input.taskId, generation: input.generation,
    unitKey: CANDIDATE_CARDS_KEY, inputHash: input.sourceHash, payload: cards }, CandidateCardsSchema);
}
export function readCandidateCards(db: Db, taskId: string, sourceHash: string): TeachingCard[] | undefined {
  return readPrepCheckpoint(db, taskId, CANDIDATE_CARDS_KEY, sourceHash, CandidateCardsSchema);
}
