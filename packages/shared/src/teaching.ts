import { z } from "zod";
import { KnowledgeTypeSchema } from "./prep.js";

const Id = z.string().min(1);
export const EvidenceKindSchema = z.enum([
  "recall", "explanation", "boundary", "classification", "application",
  "causal_reasoning", "calculation", "representation", "execution",
  "decision", "proof", "evaluation", "justification", "observation",
]);
export const MasteryRequirementSchema = z.object({
  id: Id, kpId: Id, kind: EvidenceKindSchema,
  criterion: z.string().min(1), independent: z.boolean(),
}).strict();
export const TeachingKnowledgeSchema = z.object({
  id: Id, statement: z.string().min(1), type: KnowledgeTypeSchema,
  evidence: z.array(z.string().min(1)).min(1),
  conditions: z.array(z.string().min(1)),
  exceptions: z.array(z.string().min(1)),
}).strict();
export const TeachingTaskSchema = z.object({
  id: Id, requirementIds: z.array(Id).min(1), question: z.string().min(1),
  rubric: z.string().min(1), acceptableVariants: z.array(z.string().min(1)),
  hints: z.array(z.string().min(1)).max(4),
}).strict();
export const TeachingCardSchema = z.object({
  version: Id, lessonId: Id, sourceHash: Id, rulesVersion: Id, learnerVersion: Id,
  objective: z.string().min(1), knowledge: z.array(TeachingKnowledgeSchema).min(1),
  requirements: z.array(MasteryRequirementSchema).min(1),
  tasks: z.array(TeachingTaskSchema).min(1),
}).strict().superRefine((card, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  for (const [label, items] of [["knowledge", card.knowledge], ["requirements", card.requirements], ["tasks", card.tasks]] as const) {
    if (new Set(items.map((item) => item.id)).size !== items.length) issue(`Duplicate ${label} id`);
  }
  const kps = new Set(card.knowledge.map((kp) => kp.id));
  const requirements = new Set(card.requirements.map((r) => r.id));
  for (const r of card.requirements) if (!kps.has(r.kpId)) issue(`Unknown knowledge: ${r.kpId}`);
  const targeted = new Set<string>();
  for (const task of card.tasks) {
    if (new Set(task.requirementIds).size !== task.requirementIds.length) issue(`Duplicate task target: ${task.id}`);
    for (const id of task.requirementIds) {
      if (!requirements.has(id)) issue(`Unknown requirement: ${id}`);
      targeted.add(id);
    }
  }
  for (const r of card.requirements) if (!targeted.has(r.id)) issue(`Untested requirement: ${r.id}`);
  for (const kp of card.knowledge) if (!card.requirements.some((r) => r.kpId === kp.id)) issue(`Knowledge without requirement: ${kp.id}`);
});
export type TeachingCard = z.infer<typeof TeachingCardSchema>;
export const LearningEvidenceSchema = z.object({
  cardVersion: Id, taskId: Id, requirementId: Id, userMessageId: Id,
  answerQuote: z.string().min(1), verdict: z.enum(["satisfied", "not_satisfied", "uncertain"]),
  rationale: z.string().min(1), assessmentVersion: Id,
}).strict();
export type LearningEvidence = z.infer<typeof LearningEvidenceSchema>;
