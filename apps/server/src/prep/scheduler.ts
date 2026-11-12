import { z } from "zod";
import { requestChatCompletion, type ChatMessage } from "../dialogue/client.js";
import type { KpInput } from "./store.js";

/**
 * Course-prep pipeline step 4: lesson scheduling. The LLM proposes groupings
 * of the ordered KP list into lessons (capacity 3–7, document order
 * preserved, full coverage); deterministic validation checks the proposal
 * and falls back to the deterministic greedy packer after one failed retry.
 * The fallback is an explicit, tested, flagged design element — never a
 * ghost path.
 */

const MIN_KP_PER_LESSON = 3;
const MAX_KP_PER_LESSON = 7;
const TARGET_KP_PER_LESSON = 5;

export const LESSON_CAPACITY = {
  min: MIN_KP_PER_LESSON,
  max: MAX_KP_PER_LESSON,
  target: TARGET_KP_PER_LESSON,
} as const;

const LessonProposalSchema = z.object({
  title: z.string().min(1).max(60),
  objective: z.string().min(1).max(120),
  kpIndices: z.array(z.number().int().min(0)).min(1),
});

const ScheduleProposalSchema = z.object({
  lessons: z.array(LessonProposalSchema).min(1),
});

export interface PlannedLesson {
  title: string;
  objective: string;
  kpIndices: number[];
  /** True only when the deterministic greedy fallback created this lesson. */
  autoPacked: boolean;
}

export interface ScheduleOutcome {
  lessons: PlannedLesson[];
  /** 0 when the LLM proposal passed validation; else the fallback count. */
  autoPackedCount: number;
}

const SCHEDULER_SYSTEM_PROMPT = [
  "你是课程排课器。给你一章按文档序编号的知识点列表（index/陈述/类型）。你的唯一任务是把它们分成若干堂课，只输出一个 JSON 对象。",
  "严格规则：",
  "1. 只输出一个 JSON 对象，形如 {\"lessons\": [...]}，不要输出任何其他文字或代码块标记。",
  "2. 每堂课字段：title（≤60 字的课标题）、objective（≤120 字的一句话教学目标）、kpIndices（该课包含的知识点 index 数组）。",
  `3. 每堂课包含 ${MIN_KP_PER_LESSON}–${MAX_KP_PER_LESSON} 个知识点（目标 ${TARGET_KP_PER_LESSON} 个），整章知识点总量不足时可以少一些。`,
  "4. 每个知识点恰好分到一堂课：不遗漏、不重复、不改变文档顺序（各课的 kpIndices 拼起来必须严格递增且覆盖全部 index）。",
  "5. 同一堂课的知识点应主题相近；相邻主题尽量不拆到两课，除非容量限制迫不得已。",
].join("\n");

function buildSchedulerMessages(kps: KpInput[]): ChatMessage[] {
  const list = kps
    .map(
      (kp, index) =>
        `${index}. [${kp.type}] ${kp.statement}（小节：${kp.sectionTitle}）`,
    )
    .join("\n");
  return [
    { role: "system", content: SCHEDULER_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `本章共 ${kps.length} 个知识点，按文档序编号如下：`,
        "---",
        list,
        "---",
      ].join("\n"),
    },
  ];
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1]! : trimmed;
}

/**
 * Deterministic validation of an LLM proposal: full coverage, no duplicates,
 * document order preserved. Capacity is a hard constraint except for the
 * legal single-lesson short chapter.
 */
export function validateProposal(
  lessons: PlannedLesson[],
  kpCount: number,
): string[] {
  const violations: string[] = [];
  const seen = new Set<number>();
  let previousMax = -1;
  for (const lesson of lessons) {
    for (const index of lesson.kpIndices) {
      if (index < 0 || index >= kpCount) {
        violations.push(`index ${index} 超出知识点范围`);
      } else if (seen.has(index)) {
        violations.push(`index ${index} 重复分配`);
      } else if (index < previousMax) {
        violations.push(`index ${index} 破坏文档顺序`);
      }
      seen.add(index);
      previousMax = Math.max(previousMax, index);
    }
    if (
      lesson.kpIndices.length < MIN_KP_PER_LESSON ||
      lesson.kpIndices.length > MAX_KP_PER_LESSON
    ) {
      if (!(lessons.length === 1 && lesson.kpIndices.length < MIN_KP_PER_LESSON)) {
        violations.push(
          `课「${lesson.title}」容量 ${lesson.kpIndices.length} 超出 ${MIN_KP_PER_LESSON}–${MAX_KP_PER_LESSON}`,
        );
      }
    }
  }
  for (let i = 0; i < kpCount; i++) {
    if (!seen.has(i)) violations.push(`index ${i} 未分配`);
  }
  return violations;
}

/**
 * Deterministic greedy packer: accumulate in document order, cut when the
 * max capacity is reached or (preferably) at a section boundary once the
 * target size is met. A trailing sub-min group merges backward. Never
 * reorders, never drops.
 */
export function greedyPack(kps: KpInput[]): PlannedLesson[] {
  if (kps.length === 0) return [];

  const groups: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < kps.length; i++) {
    current.push(i);
    const next = kps[i + 1];
    const atMax = current.length >= MAX_KP_PER_LESSON;
    const boundaryAfter = !next || next.sectionIndex !== kps[i]!.sectionIndex;
    const atTarget = current.length >= TARGET_KP_PER_LESSON;
    if (atMax || (boundaryAfter && atTarget)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  if (groups.length > 1 && groups[groups.length - 1]!.length < MIN_KP_PER_LESSON) {
    const last = groups[groups.length - 1]!;
    const previous = groups[groups.length - 2]!;
    // Do not turn a legal 7-KP lesson plus a 1-KP tail into an illegal
    // 8-KP lesson. Rebalance the adjacent ordered groups instead; the packer
    // only cuts at target (>=5) or max (7), so enough KPs are available.
    while (last.length < MIN_KP_PER_LESSON) {
      const moved = previous.pop();
      if (moved === undefined) break;
      last.unshift(moved);
    }
  }

  return groups.map((indices, i) => ({
    title: lessonTitle(kps, indices, i),
    objective: `掌握「${kps[indices[0]!]!.statement}」等 ${indices.length} 个知识点`,
    kpIndices: indices,
    autoPacked: true,
  }));
}

function lessonTitle(
  kps: KpInput[],
  indices: number[],
  lessonOrder: number,
): string {
  const first = kps[indices[0]!]!;
  const last = kps[indices[indices.length - 1]!]!;
  if (first.sectionTitle === last.sectionTitle) {
    return `第 ${lessonOrder + 1} 课 ${first.sectionTitle}`;
  }
  return `第 ${lessonOrder + 1} 课 ${first.sectionTitle} 起`;
}

export interface ScheduleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  kps: KpInput[];
}

/**
 * Schedules the chapter's KPs into lessons. LLM proposal → validate →
 * one corrective retry → deterministic greedy fallback (flagged via
 * autoPackedCount).
 */
export async function scheduleLessons(
  options: ScheduleOptions,
): Promise<ScheduleOutcome> {
  const messages = buildSchedulerMessages(options.kps);
  let lastRaw = "";
  let violations: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw =
      attempt === 0
        ? await requestChatCompletion({
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            model: options.model,
            messages,
          })
        : await requestChatCompletion({
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            model: options.model,
            messages: [
              ...messages,
              { role: "assistant", content: lastRaw },
              {
                role: "user",
                content: [
                  "上一条排课方案存在以下问题：",
                  ...violations.map((v, i) => `${i + 1}. ${v}`),
                  "请重新只输出符合格式要求的 JSON 对象：每个知识点恰好分配一次、不改变顺序、每课 3–7 个知识点。",
                ].join("\n"),
              },
            ],
          });
    lastRaw = raw;

    let lessons: PlannedLesson[];
    try {
      const parsed = ScheduleProposalSchema.parse(
        JSON.parse(stripCodeFence(raw)),
      );
      lessons = parsed.lessons.map((l) => ({
        title: l.title,
        objective: l.objective,
        kpIndices: [...l.kpIndices],
        autoPacked: false,
      }));
    } catch {
      violations = ["输出无法解析为合法的排课 JSON"];
      continue;
    }

    const proposalViolations = validateProposal(lessons, options.kps.length);
    if (proposalViolations.length === 0) {
      return { lessons, autoPackedCount: 0 };
    }
    violations = proposalViolations;
  }

  const packed = greedyPack(options.kps);
  return { lessons: packed, autoPackedCount: packed.length };
}
