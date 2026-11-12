import { LessonQualitySummarySchema, type LessonKpsResponse, type LessonQualitySummary } from "@elenchi/shared";

/**
 * Workbench data: the lesson's knowledge points with live mastery marks
 * (server: GET /api/lessons/:id/kps, see apps/server/src/prep/routes.ts).
 */
export async function fetchLessonQualitySummary(lessonId: string): Promise<LessonQualitySummary> {
  const res = await fetch(`/api/lessons/${lessonId}/quality-summary`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return LessonQualitySummarySchema.parse(await res.json());
}

export async function fetchLessonKps(lessonId: string): Promise<LessonKpsResponse> {
  const res = await fetch(`/api/lessons/${lessonId}/kps`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
