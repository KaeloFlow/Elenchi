import { describe, it, expect } from "vitest";
import {
  AssessmentSchema,
  TeachingActionSchema,
  PedagogyStateSchema,
  defaultPedagogyState,
} from "../src/pedagogy/schemas.js";

const VALID_ASSESSMENT = {
  correctness: "correct",
  completeness: "complete",
  reasoningQuality: "sound",
} as const;

describe("AssessmentSchema", () => {
  it("parses a full payload", () => {
    const result = AssessmentSchema.parse({
      ...VALID_ASSESSMENT,
      misconceptions: ["误解A"],
      userSignals: ["stuck"],
      evidenceQuotes: ["原文片段"],
      coveredKpIds: ["kp-1"],
      focus: "焦点",
    });
    expect(result.misconceptions).toEqual(["误解A"]);
    expect(result.coveredKpIds).toEqual(["kp-1"]);
    expect(result.focus).toBe("焦点");
  });

  it("fills defaults when optional arrays and focus are omitted", () => {
    const result = AssessmentSchema.parse(VALID_ASSESSMENT);
    expect(result.misconceptions).toEqual([]);
    expect(result.userSignals).toEqual([]);
    expect(result.evidenceQuotes).toEqual([]);
    expect(result.coveredKpIds).toEqual([]);
    expect(result.focus).toBeNull();
  });

  it("rejects an unknown correctness value", () => {
    expect(
      AssessmentSchema.safeParse({
        ...VALID_ASSESSMENT,
        correctness: "right",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown user signal", () => {
    expect(
      AssessmentSchema.safeParse({
        ...VALID_ASSESSMENT,
        userSignals: ["bored"],
      }).success,
    ).toBe(false);
  });
});

describe("TeachingActionSchema", () => {
  it("accepts every documented action type at hint level bounds", () => {
    for (const actionType of [
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
    ] as const) {
      const result = TeachingActionSchema.safeParse({
        actionType,
        hintLevel: 0,
        focus: null,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects hintLevel outside 0..4", () => {
    expect(
      TeachingActionSchema.safeParse({
        actionType: "hint",
        hintLevel: 5,
        focus: null,
      }).success,
    ).toBe(false);
  });
});

describe("defaultPedagogyState", () => {
  it("matches PedagogyStateSchema", () => {
    expect(PedagogyStateSchema.parse(defaultPedagogyState("s1"))).toBeTruthy();
  });

  it("starts at H0 with empty counters", () => {
    const state = defaultPedagogyState("s1");
    expect(state.hintLevel).toBe(0);
    expect(state.stuckCounter).toBe(0);
    expect(state.consecutiveNoCoverage).toBe(0);
    expect(state.misconceptions).toEqual([]);
  });
});
