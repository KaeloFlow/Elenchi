import { describe, expect, it } from "vitest";
import { KnowledgeTypeSchema, PrepBudgetSchema, PrepTaskSchema, LessonReadinessSchema } from "./prep.js";

const budget = { maxCalls: 20, maxTokens: 10000, maxDurationMs: 120000, maxRepairs: 2 };
describe("quality-first prep contracts", () => {
  it("has twelve distinct teaching types without ambiguous legacy principle", () => {
    expect(new Set(KnowledgeTypeSchema.options).size).toBe(12);
    expect(KnowledgeTypeSchema.safeParse("principle").success).toBe(false);
  });
  it.each([0, -1, Infinity, NaN, 1.5])("rejects unbounded or invalid call budgets %s", (maxCalls) => {
    expect(PrepBudgetSchema.safeParse({ ...budget, maxCalls }).success).toBe(false);
  });
  it("separates successful work from lesson readiness and rejects secret fields", () => {
    const task = { id: "t", chunkId: "c", inputHash: "hash", rulesVersion: "1", status: "succeeded", generation: 0, reason: null, budget, callsUsed: 2, tokensUsed: 30, createdAt: 1, updatedAt: 2 };
    expect(PrepTaskSchema.parse(task).status).toBe("succeeded");
    expect(LessonReadinessSchema.safeParse(task.status).success).toBe(false);
    expect(PrepTaskSchema.safeParse({ ...task, apiKey: "secret" }).success).toBe(false);
  });
});
