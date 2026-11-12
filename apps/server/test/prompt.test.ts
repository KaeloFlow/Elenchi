import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildOpeningPrompt,
  composeCarryOutSummary,
  type TeachingPromptContext,
} from "../src/dialogue/prompt.js";
import { TeachingActionSchema } from "../src/pedagogy/schemas.js";

const CARD = {
  materialTitle: "微积分教程",
  chapterTitle: "第一章 极限",
  lessonTitle: "第 1 课 极限的直观",
  objective: "理解极限的直观定义",
  kps: [
    {
      id: "kp-1",
      statement: "0.999... 等于 1",
      type: "principle",
      evidence: ["0.999... 等于 1。"],
      mastered: true,
      isTarget: false,
    },
    {
      id: "kp-2",
      statement: "极限的直观定义",
      type: "concept",
      evidence: ["极限描述趋近过程"],
      mastered: false,
      isTarget: true,
    },
  ],
  focusSectionContent: "极限描述趋近过程。这是本节的原文。",
  carryInSummary: "已掌握：数列极限。待检查：无。",
};

function ctx(overrides?: Partial<TeachingPromptContext>): TeachingPromptContext {
  return {
    card: CARD,
    stateSummary: {
      hintLevel: 1,
      stuckCounter: 0,
      misconceptions: ["误解A"],
      masteredKpIds: ["kp-1"],
    },
    action: TeachingActionSchema.parse({
      actionType: "probe_evidence",
      hintLevel: 1,
      focus: "极限的直观定义",
    }),
    ...overrides,
  };
}

describe("buildSystemPrompt (lesson card renderer, v3)", () => {
  it("renders the lesson card instead of the whole chapter", () => {
    const prompt = buildSystemPrompt(ctx());
    expect(prompt).toContain("本课：第 1 课 极限的直观");
    expect(prompt).toContain("本课教学目标：理解极限的直观定义");
    expect(prompt).toContain("[→ 当前] 极限的直观定义");
    expect(prompt).toContain("[✓ 已掌握] 0.999... 等于 1");
    // Full-chunk injection is retired: only the focus section text appears.
    expect(prompt).toContain("极限描述趋近过程。这是本节的原文。");
  });

  it("carries the carry-in summary through", () => {
    expect(buildSystemPrompt(ctx())).toContain("已掌握：数列极限");
  });

  it("marks the action target KP on advance", () => {
    const action = TeachingActionSchema.parse({
      actionType: "advance",
      hintLevel: 0,
      focus: "极限的直观定义",
      targetKpId: "kp-2",
    });
    const prompt = buildSystemPrompt(
      ctx({
        action,
        stateSummary: {
          hintLevel: 0,
          stuckCounter: 0,
          misconceptions: [],
          masteredKpIds: ["kp-1"],
        },
      }),
    );
    expect(prompt).toContain("推进到下一个计划知识点");
  });

  it("renders the close_lesson instruction", () => {
    const action = TeachingActionSchema.parse({
      actionType: "close_lesson",
      hintLevel: 0,
      focus: null,
    });
    const prompt = buildSystemPrompt(ctx({ action }));
    expect(prompt).toContain("收束本课");
  });

  it("renders the H-level instruction of the action", () => {
    const prompt = buildSystemPrompt(ctx());
    expect(prompt).toContain("H1（缩小问题范围");
  });

  it("renders misconception targets and evidence quotes", () => {
    const action = TeachingActionSchema.parse({
      actionType: "probe_assumption",
      hintLevel: 1,
      focus: null,
      evidenceQuotes: ["极限描述趋近过程"],
      misconceptionTargets: ["误解A"],
    });
    const prompt = buildSystemPrompt(ctx({ action }));
    expect(prompt).toContain("需要处理的误解：误解A");
    expect(prompt).toContain("可用教材证据：「极限描述趋近过程」");
  });

  it("states the bounded knowledge boundary", () => {
    expect(buildSystemPrompt(ctx())).toContain(
      "不要超出本课课卡与焦点小节原文的知识范围",
    );
  });

  it("omits the carry-in block on the first lesson", () => {
    const prompt = buildSystemPrompt(
      ctx({ card: { ...CARD, carryInSummary: null } }),
    );
    expect(prompt).not.toContain("上一课带走的摘要");
  });
});

describe("buildOpeningPrompt", () => {
  it("asks for a retrieval review when a carry-in summary exists", () => {
    const prompt = buildOpeningPrompt({ card: CARD });
    expect(prompt).toContain("提取复习性");
    expect(prompt).toContain("已掌握：数列极限");
    expect(prompt).toContain("只提出一个问题");
  });

  it("asks for an engaging first question without a carry-in summary", () => {
    const prompt = buildOpeningPrompt({
      card: { ...CARD, carryInSummary: null },
    });
    expect(prompt).toContain("引导性问题");
    expect(prompt).not.toContain("提取复习性");
  });
});

describe("composeCarryOutSummary", () => {
  it("joins mastered statements and misconceptions deterministically", () => {
    expect(composeCarryOutSummary(["要点一", "要点二"], ["误解A"])).toBe(
      "已掌握：要点一；要点二。待检查：误解A。",
    );
  });

  it("degrades honestly with nothing mastered", () => {
    expect(composeCarryOutSummary([], [])).toBe(
      "已掌握：（本课未确认掌握的要点）。待检查：无。",
    );
  });
});
