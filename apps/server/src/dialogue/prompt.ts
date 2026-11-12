import type {
  TeachingAction,
  TeachingActionType,
} from "../pedagogy/schemas.js";

/**
 * Renders the generation-call system prompts from the deterministic teaching
 * action chosen by pedagogy/strategy.ts. v3: the tutor sees a bounded lesson
 * card (objective + KP list with evidence + progress + carry-in summary)
 * instead of the whole chapter — context shrink is the precision mechanism.
 * The old five static rules and the full-chunk injection were retired with
 * engine v2/v3. Pure function.
 */

export interface LessonKpCard {
  id: string;
  statement: string;
  type: string;
  evidence: string[];
  mastered: boolean;
  isTarget: boolean;
}

export interface LessonCardContext {
  materialTitle: string;
  chapterTitle: string;
  lessonTitle: string;
  objective: string;
  kps: LessonKpCard[];
  /** Section source text of the currently targeted KP (bounded). */
  focusSectionContent: string | null;
  /** Deterministic carry-out summary of the previous lesson, if any. */
  carryInSummary: string | null;
}

export interface StateSummary {
  hintLevel: number;
  stuckCounter: number;
  misconceptions: string[];
  masteredKpIds: string[];
}

export interface TeachingPromptContext {
  card: LessonCardContext;
  stateSummary: StateSummary;
  action: TeachingAction;
}

const ACTION_TYPE_INSTRUCTIONS: Record<TeachingActionType, string> = {
  clarify: "提出澄清性问题，帮学习者明确概念含义或题目要求",
  probe_assumption:
    "针对已识别的误解，追问其隐含假设，让学习者自己看到假设的问题",
  probe_evidence: "追问理由与依据，让学习者给出推理链或因果解释",
  probe_implication: "追问影响和后果，让学习者自己推演结论的含义",
  counterexample: "构造一个具体反例或边界情形，让学习者发现自己结论的漏洞",
  apply_transfer: "给出一个新例子或新情境，让学习者应用当前概念",
  summarize: "请学习者不看教材，用自己的话总结当前焦点",
  hint: "给出提示但不给出答案，具体强度由提示等级决定",
  explain: "给出简短解释（受控解释），随后必须让学习者复述以确认理解",
  redirect: "礼貌地把话题拉回本课的学习目标",
  advance: "推进到下一个计划知识点（见本轮聚焦知识点），用一个引导性问题开启",
  close_lesson:
    "收束本课：请学习者不看教材复述本课核心要点，确认后简短总结并预告下一课",
};

const HINT_LEVEL_INSTRUCTIONS: Record<number, string> = {
  0: "只提开放问题，不给任何方向",
  1: "缩小问题范围，让问题更具体",
  2: "提供关系或方向的提示",
  3: "提供局部事实、反例或中间步骤",
  4: "给出简短解释与推导，然后让学习者复述",
};

/** Per-KP-type strategy bias (spec v3 §8.4). Prompt-level guidance only. */
const KP_TYPE_STRATEGY: Record<string, string> = {
  concept: "概念类：先澄清含义边界，再追问依据与适用场景",
  principle: "原理类：追问隐含假设，用反例与推演后果检验理解",
  procedure: "程序类：分步回忆操作步骤，再换新情境套用",
  fact: "事实类：直接提取回忆，再放进小情境应用",
};

function renderKpList(kps: LessonKpCard[]): string[] {
  return kps.map((kp, i) => {
    const mark = kp.isTarget ? "→ 当前" : kp.mastered ? "✓ 已掌握" : " ";
    const lines = [
      `${i + 1}. [${mark}] ${kp.statement}（${KP_TYPE_STRATEGY[kp.type] ?? ""}）`,
    ];
    if (kp.evidence.length > 0) {
      lines.push(`   教材证据：${kp.evidence.map((q) => `「${q}」`).join(" ")}`);
    }
    return lines.join("\n");
  });
}

function sharedRules(): string[] {
  return [
    "教学规则（必须严格遵守）：",
    "1. 默认延迟答案：答案只作为 H4 级的最后一级脚手架；到 H4 时先给简短解释，然后必须让学习者复述以确认理解。",
    "2. 每轮只执行上面指定的一个教学动作，只提出恰好一个问题，只要求学习者完成一个认知动作。",
    "3. 回复格式：先确认学习者回答中一个具体的优点，再指出一个待检查点，然后提出问题。简短口语化，像一位耐心的私教。",
    "4. 每次追问都必须紧扣课卡中的知识点与教材证据，优先使用给出的教材证据，不要超出本课课卡与焦点小节原文的知识范围。",
    "5. 学习者过于自信或给出错误结论时，构造具体的反例或反问，让学习者自己发现漏洞。",
    "6. 不假装学习者已经理解；不在一轮中讲解或评价多个新概念。",
    "7. 如果无法根据课卡内容确定答案，明确说明不确定，不得编造。",
  ];
}

export function buildSystemPrompt(ctx: TeachingPromptContext): string {
  const { action, stateSummary, card } = ctx;
  const orNone = (items: string[]) =>
    items.length > 0 ? items.join("；") : "无";
  const targetKp = card.kps.find((kp) => kp.isTarget);

  return [
    "你是 Elenchi 的对话导师。",
    "你的目标不是尽快给出答案，而是帮助学习者形成可检验的理解。",
    "你必须优先让学习者解释、回忆、举例、比较和应用。",
    "",
    `当前教材：《${card.materialTitle}》 — 章节：${card.chapterTitle} — 本课：${card.lessonTitle}`,
    `本课教学目标：${card.objective}`,
    "",
    "本课知识点清单（这是你唯一可依据的知识来源）：",
    ...renderKpList(card.kps),
    "",
    ...(card.focusSectionContent
      ? [
          "当前焦点知识点的小节原文：",
          "---",
          card.focusSectionContent,
          "---",
          "",
        ]
      : []),
    ...(card.carryInSummary
      ? ["上一课带走的摘要（衔接用）：", card.carryInSummary, ""]
      : []),
    "学习者当前状态：",
    `- 帮助阶梯等级：H${stateSummary.hintLevel}`,
    `- 连续卡住次数：${stateSummary.stuckCounter}`,
    `- 已知误解：${orNone(stateSummary.misconceptions)}`,
    `- 已掌握知识点数：${stateSummary.masteredKpIds.length}/${card.kps.length}`,
    "",
    "本轮教学动作（必须严格执行，不得替换成其他动作）：",
    `- 动作类型：${action.actionType}（${ACTION_TYPE_INSTRUCTIONS[action.actionType]}）`,
    `- 提示等级：H${action.hintLevel}（${HINT_LEVEL_INSTRUCTIONS[action.hintLevel]}）`,
    `- 聚焦知识点：${
      targetKp
        ? targetKp.statement
        : action.focus ?? "依据课卡知识点清单选择"
    }`,
    `- 需要处理的误解：${orNone(action.misconceptionTargets)}`,
    action.evidenceQuotes.length > 0
      ? `- 可用教材证据：${action.evidenceQuotes.map((q) => `「${q}」`).join(" ")}`
      : "- 可用教材证据：从课卡中自行选取",
    "",
    ...sharedRules(),
  ].join("\n");
}

export interface OpeningPromptContext {
  card: LessonCardContext;
}

/**
 * Lesson-opening generation prompt (session creation). The tutor opens the
 * lesson: 1–2 sentence recap of the previous lesson's carry-out summary
 * (when present), one sentence objective, then exactly one opening question
 * — preferably a retrieval question from prior takeaways or the first KP.
 */
export function buildOpeningPrompt(ctx: OpeningPromptContext): string {
  const { card } = ctx;
  return [
    "你是 Elenchi 的对话导师。这是本课的开场：学习者还没有说话，你要先开口。",
    "",
    `当前教材：《${card.materialTitle}》 — 章节：${card.chapterTitle} — 本课：${card.lessonTitle}`,
    `本课教学目标：${card.objective}`,
    "",
    "本课知识点清单：",
    ...renderKpList(card.kps),
    "",
    ...(card.carryInSummary
      ? ["上一课带走的摘要：", card.carryInSummary, ""]
      : []),
    "开场要求（严格执行）：",
    card.carryInSummary
      ? "1. 用 1–2 句话回顾上一课带走的要点，然后自然过渡到本课。"
      : "1. 用 1 句话点出本课要解决的问题，吸引学习者进入思考。",
    "2. 用一句话说明本课目标。",
    card.carryInSummary
      ? "3. 提出恰好一个提取复习性问题：优先让学习者回忆上一课的要点或检查其遗留误解，其次问本课第一个知识点。"
      : "3. 提出恰好一个引导性问题开启第一个知识点，让学习者先自己尝试。",
    "4. 只提出一个问题，不给出任何答案或解释。",
    "5. 简短口语化，像一位耐心的私教。",
    "",
    ...sharedRules(),
  ].join("\n");
}

/**
 * Deterministic carry-out summary composition (zero LLM, zero hallucination).
 * Written to lessons.carryOutSummary at close-lesson persistence time.
 */
export function composeCarryOutSummary(
  masteredStatements: string[],
  openMisconceptions: string[],
): string {
  const mastered =
    masteredStatements.length > 0
      ? masteredStatements.join("；")
      : "（本课未确认掌握的要点）";
  const pending =
    openMisconceptions.length > 0
      ? openMisconceptions.join("；")
      : "无";
  return `已掌握：${mastered}。待检查：${pending}。`;
}
