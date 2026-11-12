import type {
  Assessment,
  PedagogyState,
  TeachingAction,
  TeachingActionType,
} from "./schemas.js";

/**
 * Deterministic teaching-decision state machine. Pure: no LLM, no I/O.
 * With the v3 lesson layer:
 * mastery accumulates as closed-set KP ids, advance targets the next
 * unmastered planned KP, and an exhausted plan triggers close_lesson.
 */

export const STUCK_NO_COVERAGE_THRESHOLD = 3;
export const STUCK_FOCUS_TURNS_THRESHOLD = 4;
export const STUCK_MISCONCEPTION_REPEATS = 2;
export const MAX_HINT_LEVEL = 4;
const LENGTH_COLLAPSE_WINDOW = 3;

/** The lesson plan slice the reducer needs (v3 §8.3). */
export interface LessonContext {
  /** Planned KPs in document order. */
  kps: { id: string; statement: string }[];
  /** KP ids already mastered in this session (pre-turn snapshot). */
  masteredKpIds: string[];
}

export interface ReduceInput {
  state: PedagogyState;
  assessment: Assessment;
  /**
   * Lengths of the most recent user messages, oldest first, INCLUDING the
   * current one (the orchestrator appends it before calling reduce).
   */
  recentUserLengths: number[];
  /** v3 lesson plan context; kps may be empty for legacy flows. */
  lessonContext: LessonContext;
}

export interface ReduceResult {
  state: PedagogyState;
  action: TeachingAction;
}

export function reduce(input: ReduceInput): ReduceResult {
  const { state, assessment } = input;

  // ---- state updates (spec §8.5 + v3 mastery accumulation) ----
  const misconceptions = mergeUnique(
    state.misconceptions,
    assessment.misconceptions,
  );
  const inPlanKpIds = assessment.coveredKpIds.filter((id) =>
    input.lessonContext.kps.some((kp) => kp.id === id),
  );
  // Mastery requires a solid answer (correct + sound reasoning + complete):
  // coverage alone demonstrates exposure, not mastery (spec v3 §8.3).
  const solidCoverage =
    assessment.correctness === "correct" &&
    assessment.reasoningQuality === "sound" &&
    assessment.completeness === "complete";
  const masteredKpIds = solidCoverage
    ? mergeUnique(state.masteredKpIds, inPlanKpIds)
    : state.masteredKpIds;
  const focusChanged =
    assessment.focus !== null && assessment.focus !== state.currentFocus;
  const turnsOnFocus = focusChanged ? 1 : state.turnsOnFocus + 1;
  const currentFocus = assessment.focus ?? state.currentFocus;
  const hasNewCoverage = assessment.coveredKpIds.length > 0;
  const consecutiveNoCoverage = hasNewCoverage
    ? 0
    : state.consecutiveNoCoverage + 1;

  // ---- stuck detection (spec §8.2) ----
  const repeatedMisconception = assessment.misconceptions.some((m) => {
    const occurrences = state.misconceptions.filter((s) => s === m).length;
    return occurrences + 1 >= STUCK_MISCONCEPTION_REPEATS;
  });
  const lengthCollapse = detectLengthCollapse(input.recentUserLengths);
  const stuckSignaled = assessment.userSignals.some(
    (s) => s === "stuck" || s === "frustrated",
  );
  const stuckByRule =
    consecutiveNoCoverage >= STUCK_NO_COVERAGE_THRESHOLD ||
    repeatedMisconception ||
    turnsOnFocus > STUCK_FOCUS_TURNS_THRESHOLD ||
    lengthCollapse;
  const meaningfulProgress =
    hasNewCoverage && assessment.correctness !== "incorrect";
  const stuckCounter = meaningfulProgress
    ? 0
    : stuckSignaled || stuckByRule
      ? state.stuckCounter + 1
      : state.stuckCounter;

  // ---- hint ratchet (spec §8.4): failure raises, solid mastery resets ----
  const lowQuality =
    assessment.correctness === "incorrect" ||
    assessment.correctness === "partially_correct" ||
    (assessment.correctness === "correct" &&
      (assessment.reasoningQuality === "none" ||
        assessment.reasoningQuality === "weak"));
  const solid =
    assessment.correctness === "correct" &&
    assessment.reasoningQuality === "sound" &&
    assessment.completeness === "complete";
  let hintLevel = state.hintLevel;
  if (lowQuality) hintLevel = Math.min(MAX_HINT_LEVEL, hintLevel + 1);
  else if (solid) hintLevel = 0;

  // ---- action selection (spec §8.1 priority order, first match wins) ----
  const requestsExplanation = assessment.userSignals.includes(
    "requests_explanation",
  );
  const offTopic = assessment.userSignals.includes("off_topic");
  const overconfident = assessment.userSignals.includes("overconfident");
  const notCorrect =
    assessment.correctness === "incorrect" ||
    assessment.correctness === "partially_correct";

  let actionType: TeachingActionType;
  let actionHintLevel = hintLevel;
  let targetKpId: string | null = null;

  if (requestsExplanation) {
    actionType = "explain";
    actionHintLevel = 4;
  } else if (stuckSignaled || stuckCounter > 0) {
    // Rescue ladder by stuckCounter: 1 -> H1 concrete question, 2 -> H2 local
    // hint, 3 -> H3 minimal example, >=4 -> controlled explanation (spec §8.3).
    if (stuckCounter >= 4) {
      actionType = "explain";
      actionHintLevel = 4;
    } else {
      actionType = "hint";
      actionHintLevel = Math.max(hintLevel, stuckCounter);
    }
  } else if (offTopic) {
    actionType = "redirect";
    actionHintLevel = Math.max(hintLevel, 1);
  } else if (notCorrect && assessment.misconceptions.length > 0) {
    actionType = "probe_assumption";
  } else if (assessment.correctness === "incorrect" && overconfident) {
    actionType = "counterexample";
  } else if (
    assessment.correctness === "correct" &&
    (assessment.reasoningQuality === "none" ||
      assessment.reasoningQuality === "weak")
  ) {
    actionType = "probe_evidence";
  } else if (
    assessment.correctness === "partially_correct" ||
    assessment.completeness === "partial" ||
    assessment.completeness === "missing_reasoning"
  ) {
    actionType = "hint";
    actionHintLevel = Math.max(hintLevel, 2);
  } else if (solid) {
    // v3: advance is plan-driven — target the next unmastered planned KP;
    // an exhausted plan closes the lesson (spec v3 §8.3).
    const nextKp = nextUnmasteredKp(
      input.lessonContext.kps,
      masteredKpIds,
    );
    if (nextKp === null) {
      actionType = "close_lesson";
    } else {
      actionType = "advance";
      targetKpId = nextKp.id;
    }
  } else {
    // not_applicable and any uncovered combination: re-engage.
    actionType = "clarify";
  }

  const newState: PedagogyState = {
    sessionId: state.sessionId,
    hintLevel,
    stuckCounter,
    consecutiveNoCoverage,
    turnsOnFocus,
    currentFocus,
    misconceptions,
    masteredKpIds,
  };

  const action: TeachingAction = {
    actionType,
    hintLevel: Math.min(MAX_HINT_LEVEL, actionHintLevel),
    focus:
      actionType === "advance" && targetKpId !== null
        ? input.lessonContext.kps.find((kp) => kp.id === targetKpId)!.statement
        : currentFocus,
    targetKpId,
    evidenceQuotes: assessment.evidenceQuotes,
    misconceptionTargets: assessment.misconceptions,
  };

  return { state: newState, action };
}

/** First planned KP (document order) not yet mastered; null when exhausted. */
function nextUnmasteredKp(
  kps: { id: string; statement: string }[],
  masteredKpIds: string[],
): { id: string; statement: string } | null {
  const mastered = new Set(masteredKpIds);
  return kps.find((kp) => !mastered.has(kp.id)) ?? null;
}

/**
 * Strictly-decreasing window of 3 user-message lengths whose last value is
 * less than half the first (spec §8.2 trigger 5: answer-length collapse).
 */
function detectLengthCollapse(lengths: number[]): boolean {
  if (lengths.length < LENGTH_COLLAPSE_WINDOW) return false;
  const window = lengths.slice(-LENGTH_COLLAPSE_WINDOW);
  for (let i = 1; i < window.length; i++) {
    if (window[i]! >= window[i - 1]!) return false;
  }
  return window[window.length - 1]! * 2 < window[0]!;
}

function mergeUnique(base: string[], additions: string[]): string[] {
  const out = [...base];
  for (const item of additions) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}
