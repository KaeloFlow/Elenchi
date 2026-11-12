import { z } from "zod";
import { requestChatCompletion, type ChatMessage } from "../dialogue/client.js";
import type { PrepSection } from "./splitter.js";
import type { KpInput } from "./store.js";
import { KnowledgeTypeSchema } from "@elenchi/shared";

/**
 * Course-prep pipeline step 2: LLM extraction of atomic teachable knowledge
 * points, batched over consecutive sections. Every KP must carry verbatim
 * evidence quotes — machine-verified as exact substrings of the owning
 * section's content. Validation failure retries once with corrective
 * feedback, then fails explicitly (no silent partial prep).
 */

export class PrepExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrepExtractionError";
  }
}

const KP_TYPES = [...KnowledgeTypeSchema.options, "principle"] as const;

const ExtractedKpSchema = z.object({
  statement: z.string().min(1).max(120),
  type: z.enum(KP_TYPES),
  evidenceQuotes: z.array(z.string().min(1)).min(1).max(3),
  sectionIndex: z.number().int().min(0),
});
export type ExtractedKp = z.infer<typeof ExtractedKpSchema>;

export const ExtractedKpListSchema = z.object({
  knowledgePoints: z.array(ExtractedKpSchema).max(20),
});

/** Tunable batching constants (spec §7.2). */
export const MAX_BATCH_CHARS = 2000;
export const MAX_BATCH_SECTIONS = 5;

export interface SectionBatch {
  sectionIndexes: number[];
  combinedContent: string;
}

function serializeSection(section: PrepSection): string {
  return `[节 ${section.index}] ${section.title}\n${section.content}`;
}

export function batchSections(sections: PrepSection[]): SectionBatch[] {
  const batches: SectionBatch[] = [];
  let current: PrepSection[] = [];
  let combinedContent = "";

  const flush = () => {
    if (current.length > 0) {
      batches.push({
        sectionIndexes: current.map((s) => s.index),
        combinedContent,
      });
      current = [];
      combinedContent = "";
    }
  };

  for (const section of sections) {
    const serialized = serializeSection(section);
    const candidate = current.length === 0
      ? serialized
      : `${combinedContent}\n\n${serialized}`;
    if (
      current.length >= MAX_BATCH_SECTIONS ||
      (current.length > 0 && candidate.length > MAX_BATCH_CHARS)
    ) {
      flush();
    }
    current.push(section);
    combinedContent = current.length === 1
      ? serialized
      : `${combinedContent}\n\n${serialized}`;
  }
  flush();
  return batches;
}

const EXTRACTION_SYSTEM_PROMPT = [
  "你是教材知识点抽取器。你的唯一任务是从给出的章节小节原文中抽取原子知识点，只输出一个 JSON 对象。",
  "严格规则：",
  "1. 只输出一个 JSON 对象，形如 {\"knowledgePoints\": [...]}，不要输出任何其他文字或 markdown 代码块标记。",
  "2. 每个知识点字段：",
  "   statement: 字符串（≤80 字的单一可教命题陈述句，一个知识点只说一件事）",
  "   type: \"concept\" | \"principle\" | \"procedure\" | \"fact\"（概念/原理/程序/事实）",
  "   evidenceQuotes: 字符串数组（1–3 条，必须逐字复制小节原文中的连续片段，不得改写、不得拼接）",
  "   sectionIndex: 数字（该知识点所属小节的编号，必须使用输入中 [节 N] 标注的 N）",
  "3. 只抽取教材主张为真且值得教学的内容（定义、原理、方法、事实、例证的结论）。",
  "4. 目录式、承接式、无知识增量的文字不抽取。",
  "5. 若某小节没有可抽取的知识点，不要为它编造。",
].join("\n");

function buildExtractionMessages(batch: SectionBatch): ChatMessage[] {
  return [
    { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: ["章节小节原文：", "---", batch.combinedContent, "---"].join("\n"),
    },
  ];
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1]! : trimmed;
}

function normalizeExtractionPayload(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return json;
  }
  const payload = json as { knowledgePoints?: unknown };
  if (!Array.isArray(payload.knowledgePoints)) {
    return json;
  }

  // Evidence is supporting material, not a separate knowledge point. LLMs
  // occasionally emit more than the requested three quotes; keep the
  // deterministic contract without failing an otherwise usable extraction.
  return {
    ...payload,
    knowledgePoints: payload.knowledgePoints.map((kp) => {
      if (!kp || typeof kp !== "object" || Array.isArray(kp)) {
        return kp;
      }
      const point = kp as { evidenceQuotes?: unknown };
      return Array.isArray(point.evidenceQuotes)
        ? { ...point, evidenceQuotes: point.evidenceQuotes.slice(0, 3) }
        : kp;
    }),
  };
}

function parseExtraction(raw: string): ExtractedKp[] {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new PrepExtractionError("抽取失败：LLM 未返回合法 JSON");
  }
  const result = ExtractedKpListSchema.safeParse(normalizeExtractionPayload(json));
  if (!result.success) {
    throw new PrepExtractionError(
      `抽取失败：LLM 返回的结构不符合预期格式（${result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}）`,
    );
  }
  return result.data.knowledgePoints;
}

/**
 * Verbatim anchoring: every persisted evidence quote must be an exact
 * substring of the owning section's source content. Markdown punctuation can
 * be meaningful textbook content (for example `2*3`, `snake_case`, or inline
 * code), so it must never be removed while checking evidence.
 */
export function checkVerbatimEvidence(
  kps: ExtractedKp[],
  sections: PrepSection[],
): string[] {
  const byIndex = new Map(sections.map((s) => [s.index, s]));
  const violations: string[] = [];
  for (const kp of kps) {
    const section = byIndex.get(kp.sectionIndex);
    if (!section) {
      violations.push(
        `知识点「${kp.statement}」引用了不存在的小节 ${kp.sectionIndex}`,
      );
      continue;
    }
    for (const quote of kp.evidenceQuotes) {
      if (!section.content.includes(quote)) {
        violations.push(
          `知识点「${kp.statement}」的证据引文不是小节 ${kp.sectionIndex} 原文的逐字片段：「${quote.slice(0, 50)}」`,
        );
      }
    }
  }
  return violations;
}

interface ExtractionAttempt {
  kps?: ExtractedKp[];
  violations?: string[];
}

function tryExtract(raw: string, sections: PrepSection[]): ExtractionAttempt {
  try {
    const kps = parseExtraction(raw);
    const violations = checkVerbatimEvidence(kps, sections);
    if (violations.length > 0) {
      return { violations };
    }
    return { kps };
  } catch (err) {
    return { violations: [err instanceof Error ? err.message : String(err)] };
  }
}

function toKpInputs(
  kps: ExtractedKp[],
  sections: PrepSection[],
): KpInput[] {
  return kps.map((kp) => {
    const section = sections.find((s) => s.index === kp.sectionIndex)!;
    return {
      statement: kp.statement,
      type: kp.type === "principle" ? "mechanism" : kp.type,
      sectionIndex: kp.sectionIndex,
      sectionTitle: section.title,
      evidence: kp.evidenceQuotes,
    };
  });
}

export interface ExtractOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  sections: PrepSection[];
}

/**
 * Extracts KPs batch by batch. On verbatim or parse violations, retries the
 * whole batch once with the specific violations as corrective feedback;
 * a second failure throws PrepExtractionError (explicit failure of the
 * chapter's prep — the caller records it and the user can retry).
 */
export async function extractKnowledgePoints(
  options: ExtractOptions,
): Promise<KpInput[]> {
  const batches = batchSections(options.sections);
  const results: KpInput[] = [];

  for (const batch of batches) {
    const messages = buildExtractionMessages(batch);
    const first = await requestChatCompletion({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      messages,
    });

    const attempt = tryExtract(first, options.sections);
    if (attempt.kps) {
      results.push(...toKpInputs(attempt.kps, options.sections));
      continue;
    }

    // One corrective retry with the specific violations.
    const second = await requestChatCompletion({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      messages: [
        ...messages,
        { role: "assistant", content: first },
        {
          role: "user",
          content: [
            "上一条输出存在以下问题：",
            ...attempt.violations!.map((v, i) => `${i + 1}. ${v}`),
            "请重新只输出符合格式要求的 JSON 对象：修正列出的每一条问题；evidenceQuotes 必须逐字复制小节原文的连续片段。",
          ].join("\n"),
        },
      ],
    });
    const retried = tryExtract(second, options.sections);
    if (!retried.kps) {
      throw new PrepExtractionError(
        `抽取失败：校验两次未通过（${retried.violations?.[0] ?? "未知原因"}）`,
      );
    }
    results.push(...toKpInputs(retried.kps, options.sections));
  }

  return results;
}
