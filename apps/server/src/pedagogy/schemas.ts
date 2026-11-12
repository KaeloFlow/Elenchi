import { z } from "zod";

/**
 * Server-internal contracts for the pedagogy pipeline (assess -> reduce ->
 * generate). These never cross the API boundary — the SSE stream contract in
 * packages/shared/src/dialogue.ts is unchanged — so they live in the server,
 * matching the repo rule that @elenchi/shared only holds web-consumed
 * contracts.
 */

export const AssessmentCorrectnessSchema = z.enum([
  "correct",
  "partially_correct",
  "incorrect",
  "not_applicable",
]);
export type AssessmentCorrectness = z.infer<typeof AssessmentCorrectnessSchema>;

export const AssessmentCompletenessSchema = z.enum([
  "complete",
  "partial",
  "missing_reasoning",
]);

export const AssessmentReasoningSchema = z.enum(["none", "weak", "sound"]);

export const AssessmentSignalSchema = z.enum([
  "stuck",
  "frustrated",
  "requests_explanation",
  "overconfident",
  "off_topic",
]);

export const EvidenceProposalSchema = z.object({
  taskId: z.string().min(1),
  requirementId: z.string().min(1),
  answerQuote: z.string().min(1),
  verdict: z.enum(["satisfied", "not_satisfied", "uncertain"]),
  rationale: z.string().min(1),
}).strict();
export type EvidenceProposal = z.infer<typeof EvidenceProposalSchema>;

export const AssessmentSchema = z.object({
  correctness: AssessmentCorrectnessSchema,
  completeness: AssessmentCompletenessSchema,
  reasoningQuality: AssessmentReasoningSchema,
  misconceptions: z.array(z.string().min(1)).max(5).default([]),
  userSignals: z.array(AssessmentSignalSchema).default([]),
  evidenceQuotes: z.array(z.string()).max(5).default([]),
  /**
   * v3 closed-set coverage: the lesson's KP ids the answer demonstrated.
   * The server validates subset-of-lesson (machine-checkable coverage —
   * replaces the v2 free-form newCoverage strings).
   */
  coveredKpIds: z.array(z.string()).default([]),
  /** Model proposal only; routes bind message/card identity and revalidate it. */
  evidence: z.array(EvidenceProposalSchema).max(20).default([]),
  focus: z.string().nullable().default(null),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const TeachingActionTypeSchema = z.enum([
  "clarify",
  "probe_assumption",
  "probe_evidence",
  "probe_implication",
  "counterexample",
  "apply_transfer",
  "summarize",
  "hint",
  "explain",
  "redirect",
  "advance",
  "close_lesson",
]);
export type TeachingActionType = z.infer<typeof TeachingActionTypeSchema>;

export const TeachingActionSchema = z.object({
  actionType: TeachingActionTypeSchema,
  hintLevel: z.number().int().min(0).max(4),
  focus: z.string().nullable(),
  /** v3: set on advance — the planned KP this action targets. */
  targetKpId: z.string().nullable().default(null),
  evidenceQuotes: z.array(z.string()).default([]),
  misconceptionTargets: z.array(z.string()).default([]),
});
export type TeachingAction = z.infer<typeof TeachingActionSchema>;

export const PedagogyStateSchema = z.object({
  sessionId: z.string(),
  hintLevel: z.number().int().min(0).max(4),
  stuckCounter: z.number().int().min(0),
  consecutiveNoCoverage: z.number().int().min(0),
  turnsOnFocus: z.number().int().min(0),
  currentFocus: z.string().nullable(),
  misconceptions: z.array(z.string()),
  /** v3: KP ids mastered within this session (solid-assessment coverage). */
  masteredKpIds: z.array(z.string()),
});
export type PedagogyState = z.infer<typeof PedagogyStateSchema>;

export function defaultPedagogyState(sessionId: string): PedagogyState {
  return {
    sessionId,
    hintLevel: 0,
    stuckCounter: 0,
    consecutiveNoCoverage: 0,
    turnsOnFocus: 0,
    currentFocus: null,
    misconceptions: [],
    masteredKpIds: [],
  };
}
