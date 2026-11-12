import { LearningEvidenceSchema, TeachingCardSchema, type LearningEvidence, type TeachingCard } from "@elenchi/shared";

/** Trusted server-owned task delivery metadata; never accept assistance flags from assessment LLMs. */
export interface TaskAttempt {
  cardVersion: string;
  taskId: string;
  userMessageId: string;
  answer: string;
  assistance: "none" | "hint" | "explanation";
  observedPerformance: boolean;
}
export interface MasteryEvidenceResult {
  satisfiedRequirementIds: string[];
  masteredKpIds: string[];
  complete: boolean;
  rejected: { index: number; reason: string }[];
}

/** Structural eligibility only. A grounded model verdict still needs semantic quality evaluation. */
export function evaluateMasteryEvidence(
  cardInput: TeachingCard, evidence: LearningEvidence[], attempts: TaskAttempt[],
): MasteryEvidenceResult {
  const card = TeachingCardSchema.parse(cardInput);
  const attemptMap = new Map<string, TaskAttempt>();
  for (const attempt of attempts) {
    const key = JSON.stringify([attempt.cardVersion, attempt.taskId, attempt.userMessageId]);
    if (attemptMap.has(key)) throw new Error("Duplicate task attempt identity");
    attemptMap.set(key, attempt);
  }
  const satisfied = new Set<string>();
  const rejected: MasteryEvidenceResult["rejected"] = [];
  evidence.forEach((candidate, index) => {
    const parsed = LearningEvidenceSchema.safeParse(candidate);
    const reject = (reason: string) => { rejected.push({ index, reason }); };
    if (!parsed.success) return reject("invalid_evidence");
    const item = parsed.data;
    if (item.cardVersion !== card.version) return reject("version_mismatch");
    const requirement = card.requirements.find((r) => r.id === item.requirementId);
    const task = card.tasks.find((t) => t.id === item.taskId);
    if (!requirement || !task?.requirementIds.includes(item.requirementId)) return reject("unknown_target");
    const attempt = attemptMap.get(JSON.stringify([item.cardVersion, item.taskId, item.userMessageId]));
    if (!attempt || !attempt.answer.includes(item.answerQuote)) return reject("ungrounded_answer");
    if (requirement.independent && attempt.assistance !== "none") return reject("assisted_attempt");
    if (requirement.kind === "observation" && !attempt.observedPerformance) return reject("unobserved_performance");
    if (item.verdict === "satisfied") satisfied.add(item.requirementId);
  });
  const satisfiedRequirementIds = card.requirements.filter((r) => satisfied.has(r.id)).map((r) => r.id);
  const masteredKpIds = card.knowledge.filter((kp) =>
    card.requirements.filter((r) => r.kpId === kp.id).every((r) => satisfied.has(r.id)),
  ).map((kp) => kp.id);
  return { satisfiedRequirementIds, masteredKpIds,
    complete: satisfiedRequirementIds.length === card.requirements.length, rejected };
}
