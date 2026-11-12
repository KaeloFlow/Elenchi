import { describe, expect, it } from "vitest";
import { KnowledgeTypeSchema } from "@elenchi/shared";
import { buildTeachingCard } from "../src/prep/card-builder.js";
const types = KnowledgeTypeSchema.options;
describe("teaching card builder", () => {
  it("creates a testable contract for every one of twelve types", () => {
    const card = buildTeachingCard({ version: "v", lessonId: "l", source: "教材原文", rulesVersion: "r", learnerVersion: "0", objective: "掌握本课", knowledge: types.map((type, i) => ({ id: `k${i}`, statement: `命题${i}`, type, evidence: ["教材原文"], conditions: [], exceptions: [] })) });
    expect(card.knowledge).toHaveLength(12);
    expect(card.requirements).toHaveLength(12);
    expect(card.tasks).toHaveLength(12);
    expect(new Set(card.requirements.map((r) => r.kind)).size).toBeGreaterThan(8);
    for (const [index, type] of types.entries()) {
      expect(card.knowledge[index]?.type).toBe(type);
      expect(card.requirements[index]?.kpId).toBe(`k${index}`);
      expect(card.tasks[index]?.requirementIds).toEqual([`requirement:k${index}`]);
      expect(card.tasks[index]?.question).toContain(`命题${index}`);
    }
  });
  it("keeps source hash and evidence exact", () => {
    const card = buildTeachingCard({ version: "v", lessonId: "l", source: "公式 `2*3=6`", rulesVersion: "r", learnerVersion: "0", objective: "应用", knowledge: [{ id: "k", statement: "公式", type: "formula", evidence: ["公式 `2*3=6`"], conditions: ["给定条件"], exceptions: [] }] });
    expect(card.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(card.knowledge[0]!.evidence[0]).toContain("2*3");
  });
  it("fails closed for ungrounded evidence rather than inventing a target", () => {
    expect(() => buildTeachingCard({ version: "v", lessonId: "l", source: "x", rulesVersion: "r", learnerVersion: "0", objective: "x", knowledge: [{ id: "k", statement: "x", type: "concept", evidence: ["not source"], conditions: [], exceptions: [] }] })).toThrow("card_evidence_not_grounded");
  });
});
