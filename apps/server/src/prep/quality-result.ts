import { KnowledgeTypeSchema, type KnowledgeType } from "@elenchi/shared";
import { greedyPack, type PlannedLesson } from "./scheduler.js";
import type { PreparedKnowledge } from "./knowledge-preparation.js";
import type { KpInput } from "./store.js";

export interface QualityPreparedUnit { sourceStart: number; sourceEnd: number; points: PreparedKnowledge[] }
export interface QualityLessonCandidate { lesson: PlannedLesson; kpIds: string[] }
export interface QualityResult { kps: (KpInput & { id: string; conditions: string[]; exceptions: string[] })[]; lessons: QualityLessonCandidate[]; sourceCoverage: { start: number; end: number }[] }

/** Converts checkpoint payloads into a deterministic, ordered candidate; no publication occurs here. */
export function buildQualityResult(units: QualityPreparedUnit[], sectionTitle: string): QualityResult {
  const ordered = [...units].sort((a, b) => a.sourceStart - b.sourceStart);
  const kps: (KpInput & { id: string; conditions: string[]; exceptions: string[] })[] = [];
  for (const unit of ordered) for (const point of unit.points) {
    const type = KnowledgeTypeSchema.parse(point.type) as KnowledgeType;
    const id = `kp:${unit.sourceStart}:${kps.length}`;
    kps.push({ id, statement: point.statement, type, sectionIndex: 0, sectionTitle, evidence: point.evidence,
      conditions: point.conditions, exceptions: point.exceptions });
  }
  const planned = greedyPack(kps);
  return { kps, lessons: planned.map((lesson) => ({ lesson, kpIds: lesson.kpIndices.map((i) => kps[i]!.id) })),
    sourceCoverage: ordered.map((unit) => ({ start: unit.sourceStart, end: unit.sourceEnd })) };
}
