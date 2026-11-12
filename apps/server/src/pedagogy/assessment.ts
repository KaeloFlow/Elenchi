import { requestChatCompletion, type ChatMessage } from "../dialogue/client.js";
import {
  AssessmentSchema,
  type Assessment,
} from "./schemas.js";
import type { TeachingCard } from "@elenchi/shared";

/**
 * Pipeline step 1: call the LLM once (non-streaming) as a learning ANALYZER
 * (not a tutor) to grade the user's latest answer against the chunk text.
 * Authority: spec §7. On unparseable output, retries once with the parse
 * error as corrective feedback, then fails explicitly — no silent fallback
 * to stateless chat.
 */

export class PedagogyAssessmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PedagogyAssessmentError";
  }
}

export interface AssessmentLessonKp {
  id: string;
  statement: string;
  type: string;
}

export interface AssessmentContext {
  /** The current lesson's KP list (closed set for coveredKpIds). */
  lessonKps: AssessmentLessonKp[];
  /** The currently targeted KP, or null before the first focus. */
  targetKp: AssessmentLessonKp | null;
  /** The target KP's section source text (judging basis). */
  focusSectionContent: string;
  /** Most recent messages before the current answer (already windowed). */
  recentMessages: { role: "user" | "assistant"; content: string }[];
  userAnswer: string;
  /** Present only when the session is pinned to a published quality card/task. */
  taskScope?: { card: TeachingCard; taskId: string };
}

const ASSESSMENT_SYSTEM_PROMPT = [
  "你是学习分析器，不是导师。你的唯一任务是评估学生最新一条回答的质量，只输出一个 JSON 对象。",
  "评估的唯一判分依据是下方给出的知识点证据与本节原文。",
  "",
  "严格规则：",
  "1. 只输出一个 JSON 对象，不要输出 JSON 之外的任何文字或 markdown 代码块标记。",
  "2. JSON 字段与取值：",
  '   correctness: "correct" | "partially_correct" | "incorrect" | "not_applicable"（问候、元问题、无法判定对错的表达用 not_applicable）',
  '   completeness: "complete" | "partial" | "missing_reasoning"',
  '   reasoningQuality: "none" | "weak" | "sound"',
  "   misconceptions: string[]（学生表现出的错误理解，每条一个短语，最多 5 条；没有则 []）",
  '   userSignals: string[]（"stuck"|"frustrated"|"requests_explanation"|"overconfident"|"off_topic" 中的零个或多个；空回答或「我不知道」归为 stuck）',
  "   evidenceQuotes: string[]（支撑你判断的原文逐字引文，最多 5 条）",
  "   coveredKpIds: string[]（本条回答展现掌握的知识点 id，只能从下方列出的 id 中选取；没有则 []）",
  "   focus: string | null（当前对话聚焦的子目标，一句话；无法判断为 null）",
  "3. evidenceQuotes 必须逐字来自给出的原文，不得改写。",
  "4. coveredKpIds 只允许使用本课知识点清单中列出的 id，不得发明新 id。",
  "5. 无法依据原文判定对错时，correctness 用 not_applicable，不要编造。",
].join("\n");

function buildAssessmentMessages(ctx: AssessmentContext): ChatMessage[] {
  const taskScope = ctx.taskScope ? `任务证据范围：taskId=${ctx.taskScope.taskId}；requirementIds=${ctx.taskScope.card.tasks.find((task) => task.id === ctx.taskScope!.taskId)?.requirementIds.join(",") ?? ""}。若输出 evidence，answerQuote 必须逐字来自学生最新回答。` : "无任务证据范围；evidence 必须为空。";
  const transcript = ctx.recentMessages
    .map((m) => `${m.role === "user" ? "学生" : "AI 伙伴"}：${m.content}`)
    .join("\n");
  const kpList = ctx.lessonKps
    .map((kp) => `- [${kp.id}]（${kp.type}）${kp.statement}`)
    .join("\n");

  return [
    { role: "system", content: ASSESSMENT_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "本课知识点清单（coveredKpIds 只能从中选取）：",
        kpList || "（无）",
         taskScope,
        "",
        ctx.targetKp
          ? `当前焦点知识点：[${ctx.targetKp.id}] ${ctx.targetKp.statement}`
          : "当前焦点知识点：尚未确定",
        "",
        "焦点知识点所在小节原文（判分依据）：",
        "---",
        ctx.focusSectionContent,
        "---",
        "",
        "最近对话：",
        transcript || "（无）",
        "",
        `学生最新回答：${ctx.userAnswer}`,
      ].join("\n"),
    },
  ];
}

/**
 * Strips a ```json ... ``` or ``` ... ``` fence if the model wrapped its
 * output despite the system prompt's instruction not to. Best-effort only —
 * if there's no fence, the input is returned unchanged. (Same pattern as
 * flashcards/generator.ts.)
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1]! : trimmed;
}

function parseAssessment(
  raw: string,
  lessonKpIds: Set<string>,
  context: AssessmentContext,
): Assessment {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new PedagogyAssessmentError("评估失败：LLM 未返回合法 JSON");
  }
  const result = AssessmentSchema.safeParse(json);
  if (!result.success) {
    throw new PedagogyAssessmentError(
      `评估失败：LLM 返回的结构不符合预期格式（${result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}）`,
    );
  }
  // Closed-set coverage: reject ids outside the lesson's KP list.
  const violations = result.data.coveredKpIds.filter(
    (id) => !lessonKpIds.has(id),
  );
  if (violations.length > 0) {
    throw new PedagogyAssessmentError(
      `评估失败：coveredKpIds 含本课之外的 id（${violations.join("、")}）`,
    );
  }
  const allowedRequirements = new Set(context.taskScope?.card.tasks.find((task) => task.id === context.taskScope!.taskId)?.requirementIds ?? []);
  const invalidEvidence = result.data.evidence.some((item) => !context.taskScope || item.taskId !== context.taskScope.taskId || !allowedRequirements.has(item.requirementId) || !context.userAnswer.includes(item.answerQuote));
  if (invalidEvidence) throw new PedagogyAssessmentError("评估失败：evidence 不属于当前任务或未锚定学生回答");
  return result.data;
}

export interface AssessAnswerOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  context: AssessmentContext;
}

export async function assessAnswer(
  options: AssessAnswerOptions,
): Promise<Assessment> {
  const messages = buildAssessmentMessages(options.context);
  const lessonKpIds = new Set(
    options.context.lessonKps.map((kp) => kp.id),
  );

  const first = await requestChatCompletion({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    messages,
  });
  try {
    return parseAssessment(first, lessonKpIds, options.context);
  } catch (err) {
    // One corrective retry, then explicit failure.
    const second = await requestChatCompletion({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      messages: [
        ...messages,
        { role: "assistant", content: first },
        {
          role: "user",
          content: `上一条输出无法解析（${err instanceof Error ? err.message : String(err)}）。请重新只输出符合格式要求的 JSON 对象：coveredKpIds 只能使用本课知识点清单中的 id，不要输出任何其他文字。`,
        },
      ],
    });
    return parseAssessment(second, lessonKpIds, options.context);
  }
}
