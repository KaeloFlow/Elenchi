import { describe, it, expect } from "vitest";
import { reduce, type ReduceInput } from "../src/pedagogy/strategy.js";
import {
  AssessmentSchema,
  defaultPedagogyState,
  type Assessment,
} from "../src/pedagogy/schemas.js";

function assessment(overrides: Partial<Assessment> = {}): Assessment {
  return AssessmentSchema.parse({
    correctness: "correct",
    completeness: "complete",
    reasoningQuality: "sound",
    ...overrides,
  });
}

const NO_LENGTHS = [50];

/** A three-KP plan used by most tests. */
const PLAN = [
  { id: "k1", statement: "知识点一" },
  { id: "k2", statement: "知识点二" },
  { id: "k3", statement: "知识点三" },
];

function run(
  overrides: Partial<Assessment> = {},
  state = defaultPedagogyState("s1"),
  recentUserLengths: number[] = NO_LENGTHS,
  lessonContext: ReduceInput["lessonContext"] = {
    kps: PLAN,
    masteredKpIds: state.masteredKpIds,
  },
) {
  return reduce({
    state,
    assessment: assessment(overrides),
    recentUserLengths,
    lessonContext,
  } satisfies ReduceInput);
}

describe("routing matrix (priority order, first match wins)", () => {
  it("row 1: requests_explanation -> explain at H4 regardless of ratchet", () => {
    const { action } = run({ userSignals: ["requests_explanation"] });
    expect(action.actionType).toBe("explain");
    expect(action.hintLevel).toBe(4);
  });

  it("row 2: stuck signal enters the rescue ladder at rung 1", () => {
    const { action, state } = run({ userSignals: ["stuck"] });
    expect(action.actionType).toBe("hint");
    expect(action.hintLevel).toBeGreaterThanOrEqual(1);
    expect(state.stuckCounter).toBe(1);
  });

  it("row 3: off_topic -> redirect", () => {
    const { action } = run({
      correctness: "not_applicable",
      userSignals: ["off_topic"],
    });
    expect(action.actionType).toBe("redirect");
  });

  it("row 4: incorrect with misconceptions -> probe_assumption", () => {
    const { action } = run({
      correctness: "incorrect",
      misconceptions: ["误解A"],
    });
    expect(action.actionType).toBe("probe_assumption");
    expect(action.misconceptionTargets).toEqual(["误解A"]);
  });

  it("row 5: incorrect + overconfident without misconception -> counterexample", () => {
    const { action } = run({
      correctness: "incorrect",
      userSignals: ["overconfident"],
    });
    expect(action.actionType).toBe("counterexample");
  });

  it("row 6: correct but no reasoning -> probe_evidence", () => {
    const { action } = run({ reasoningQuality: "none" });
    expect(action.actionType).toBe("probe_evidence");
  });

  it("row 7: partially_correct -> hint targeting the gap", () => {
    const { action } = run({ correctness: "partially_correct" });
    expect(action.actionType).toBe("hint");
    expect(action.hintLevel).toBeGreaterThanOrEqual(2);
  });

  it("row 8a: solid answer -> advance to the next unmastered planned KP", () => {
    const { action } = run({ focus: "焦点二" });
    expect(action.actionType).toBe("advance");
    expect(action.targetKpId).toBe("k1");
    expect(action.focus).toBe("知识点一");
  });

  it("row 8b: solid answer -> advance skips already-mastered KPs", () => {
    const state = {
      ...defaultPedagogyState("s1"),
      masteredKpIds: ["k1"],
    };
    const { action } = run({ focus: "焦点一" }, state);
    expect(action.actionType).toBe("advance");
    expect(action.targetKpId).toBe("k2");
  });

  it("row 8c: solid answer with the plan exhausted -> close_lesson", () => {
    const state = {
      ...defaultPedagogyState("s1"),
      masteredKpIds: ["k1", "k2", "k3"],
    };
    const { action } = run({}, state);
    expect(action.actionType).toBe("close_lesson");
  });

  it("row 9: not_applicable -> clarify", () => {
    const { action } = run({ correctness: "not_applicable" });
    expect(action.actionType).toBe("clarify");
  });
});

describe("hint ratchet (spec §8.4)", () => {
  it("ratchets up by one on each low-quality turn", () => {
    const first = run({ correctness: "incorrect", misconceptions: ["A"] });
    expect(first.state.hintLevel).toBe(1);
    const second = run(
      { correctness: "incorrect", misconceptions: ["B"] },
      first.state,
    );
    expect(second.state.hintLevel).toBe(2);
  });

  it("caps at H4", () => {
    let state = defaultPedagogyState("s1");
    for (let i = 0; i < 6; i++) {
      state = run(
        {
          correctness: "incorrect",
          misconceptions: [`m${i}`],
          coveredKpIds: ["k1"],
        },
        state,
      ).state;
    }
    expect(state.hintLevel).toBe(4);
  });

  it("resets to H0 on a solid answer", () => {
    const state = { ...defaultPedagogyState("s1"), hintLevel: 3 };
    const next = run({ coveredKpIds: ["k1"] }, state);
    expect(next.state.hintLevel).toBe(0);
  });
});

describe("stuck detection (spec §8.2)", () => {
  it("fires on the stuck signal itself", () => {
    const { state } = run({ userSignals: ["frustrated"] });
    expect(state.stuckCounter).toBe(1);
  });

  it("fires after 3 consecutive turns with no new coverage", () => {
    // state already carries 2 no-coverage turns; this turn adds the 3rd
    const state = {
      ...defaultPedagogyState("s1"),
      consecutiveNoCoverage: 2,
    };
    const next = run(
      { correctness: "correct", completeness: "partial", coveredKpIds: [] },
      state,
    );
    expect(next.state.stuckCounter).toBe(1);
    expect(next.action.actionType).toBe("hint");
  });

  it("fires when a misconception repeats (2nd occurrence)", () => {
    const state = {
      ...defaultPedagogyState("s1"),
      misconceptions: ["误解A"],
    };
    const next = run(
      { correctness: "incorrect", misconceptions: ["误解A"] },
      state,
    );
    expect(next.state.stuckCounter).toBe(1);
  });

  it("fires when turnsOnFocus exceeds 4", () => {
    const state = {
      ...defaultPedagogyState("s1"),
      turnsOnFocus: 4,
      currentFocus: "焦点一",
    };
    const next = run({ correctness: "correct", focus: "焦点一" }, state);
    expect(next.state.stuckCounter).toBe(1);
  });

  it("fires on answer-length collapse", () => {
    const next = run(
      { correctness: "correct" },
      defaultPedagogyState("s1"),
      [100, 40, 10],
    );
    expect(next.state.stuckCounter).toBe(1);
  });

  it("does not fire on flat or growing lengths", () => {
    const next = run(
      { correctness: "correct" },
      defaultPedagogyState("s1"),
      [50, 60, 70],
    );
    expect(next.state.stuckCounter).toBe(0);
  });

  it("resets the counter on meaningful progress", () => {
    const state = {
      ...defaultPedagogyState("s1"),
      stuckCounter: 2,
    };
    const next = run({ correctness: "correct", coveredKpIds: ["k1"] }, state);
    expect(next.state.stuckCounter).toBe(0);
  });
});

describe("rescue ladder (spec §8.3)", () => {
  it("rung 1 -> hint H1, rung 2 -> H2, rung 3 -> H3, rung 4 -> explain H4", () => {
    const rung1 = run(
      { userSignals: ["stuck"], correctness: "incorrect" },
      { ...defaultPedagogyState("s1"), stuckCounter: 0 },
    );
    expect(rung1.action.actionType).toBe("hint");
    expect(rung1.action.hintLevel).toBe(1);

    const rung2 = run(
      { userSignals: ["stuck"], correctness: "incorrect" },
      { ...defaultPedagogyState("s1"), stuckCounter: 1 },
    );
    expect(rung2.action.hintLevel).toBe(2);

    const rung3 = run(
      { userSignals: ["stuck"], correctness: "incorrect" },
      { ...defaultPedagogyState("s1"), stuckCounter: 2 },
    );
    expect(rung3.action.hintLevel).toBe(3);

    const rung4 = run(
      { userSignals: ["stuck"], correctness: "incorrect" },
      { ...defaultPedagogyState("s1"), stuckCounter: 3 },
    );
    expect(rung4.action.actionType).toBe("explain");
    expect(rung4.action.hintLevel).toBe(4);
  });
});

describe("mastery accumulation (v3 §8.3)", () => {
  it("adds solid-covered KP ids to the mastered set", () => {
    const next = run({ coveredKpIds: ["k1", "k2"] });
    expect(next.state.masteredKpIds).toEqual(["k1", "k2"]);
  });

  it("ignores KP ids outside the lesson plan (defensive closed set)", () => {
    const next = run({ coveredKpIds: ["k1", "rogue"] });
    expect(next.state.masteredKpIds).toEqual(["k1"]);
  });

  it("does not master KPs from a merely-correct-but-weak answer", () => {
    const next = run({
      reasoningQuality: "weak",
      coveredKpIds: ["k1"],
    });
    expect(next.state.masteredKpIds).toEqual([]);
  });
});

describe("state updates (spec §8.5 + v3)", () => {
  it("merges misconceptions without duplicates and accumulates mastery", () => {
    const state = {
      ...defaultPedagogyState("s1"),
      misconceptions: ["误解A"],
      masteredKpIds: ["k1"],
    };
    const next = run(
      { misconceptions: ["误解A", "误解B"], coveredKpIds: ["k1", "k2"] },
      state,
    );
    expect(next.state.misconceptions).toEqual(["误解A", "误解B"]);
    expect(next.state.masteredKpIds).toEqual(["k1", "k2"]);
  });

  it("resets turnsOnFocus when the focus changes", () => {
    const state = {
      ...defaultPedagogyState("s1"),
      currentFocus: "焦点一",
      turnsOnFocus: 3,
    };
    const next = run({ focus: "焦点二" }, state);
    expect(next.state.currentFocus).toBe("焦点二");
    expect(next.state.turnsOnFocus).toBe(1);
  });

  it("carries evidence quotes through to the action", () => {
    const next = run({ evidenceQuotes: ["原文片段"] });
    expect(next.action.evidenceQuotes).toEqual(["原文片段"]);
  });
});
