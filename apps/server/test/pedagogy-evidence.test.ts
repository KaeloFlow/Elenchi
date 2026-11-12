import { describe, expect, it } from "vitest";
import { TeachingCardSchema, type TeachingCard, type LearningEvidence } from "@elenchi/shared";
import { evaluateMasteryEvidence, type TaskAttempt } from "../src/pedagogy/evidence.js";
const card: TeachingCard = {
  version: "v", lessonId: "l", sourceHash: "s", rulesVersion: "r", learnerVersion: "0", objective: "辨别条件",
  knowledge: [{ id: "k", statement: "命题", type: "concept", evidence: ["教材依据"], conditions: [], exceptions: [] }],
  requirements: [{ id: "r", kpId: "k", kind: "boundary", criterion: "识别适用条件", independent: true }],
  tasks: [{ id: "t", requirementIds: ["r"], question: "适用吗？", rubric: "说明条件", acceptableVariants: [], hints: [] }],
};
const attempt: TaskAttempt = { cardVersion: "v", taskId: "t", userMessageId: "m", answer: "不适用，因为缺少条件。", assistance: "none", observedPerformance: false };
const evidence: LearningEvidence = { cardVersion: "v", taskId: "t", requirementId: "r", userMessageId: "m", answerQuote: "缺少条件", verdict: "satisfied", rationale: "指出必要条件", assessmentVersion: "1" };
describe("evidence eligibility", () => {
  it("accepts grounded independent evidence without multiplying duplicate credit", () => {
    const result = evaluateMasteryEvidence(card, [evidence, evidence], [attempt]);
    expect(result.satisfiedRequirementIds).toEqual(["r"]);
    expect(result.masteredKpIds).toEqual(["k"]);
    expect(result.complete).toBe(true);
  });
  it.each(["hint", "explanation"] as const)("does not count %s assistance as independent mastery", (assistance) => {
    const result = evaluateMasteryEvidence(card, [evidence], [{ ...attempt, assistance }]);
    expect(result.complete).toBe(false);
    expect(result.rejected[0]?.reason).toBe("assisted_attempt");
  });
  it.each([
    { ...evidence, cardVersion: "old" },
    { ...evidence, answerQuote: "不存在的回答" },
    { ...evidence, requirementId: "foreign" },
    { ...evidence, userMessageId: "foreign" },
  ])("rejects mismatched or fabricated evidence", (item) => {
    expect(evaluateMasteryEvidence(card, [item], [attempt]).complete).toBe(false);
  });
  it("does not infer mastery from uncertainty or absent evidence", () => {
    expect(evaluateMasteryEvidence(card, [], [attempt]).complete).toBe(false);
    expect(evaluateMasteryEvidence(card, [{ ...evidence, verdict: "uncertain" }], [attempt]).complete).toBe(false);
  });
  it("requires actual observation for performance evidence", () => {
    const practical: TeachingCard = { ...card, requirements: [{ ...card.requirements[0]!, kind: "observation" }] };
    expect(evaluateMasteryEvidence(practical, [evidence], [attempt]).complete).toBe(false);
    expect(evaluateMasteryEvidence(practical, [evidence], [{ ...attempt, observedPerformance: true }]).complete).toBe(true);
  });
  it("rejects disconnected, duplicate, or untested targets in a card", () => {
    expect(TeachingCardSchema.safeParse({ ...card, requirements: [...card.requirements, ...card.requirements] }).success).toBe(false);
    expect(TeachingCardSchema.safeParse({ ...card, tasks: [{ ...card.tasks[0], requirementIds: ["unknown"] }] }).success).toBe(false);
    expect(TeachingCardSchema.safeParse({ ...card, requirements: [{ ...card.requirements[0], kpId: "unknown" }] }).success).toBe(false);
  });
});
