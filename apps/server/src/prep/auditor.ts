import { z } from "zod";
import { requestChatCompletion, type ChatMessage } from "../dialogue/client.js";
import { PrepExtractionError } from "./extractor.js";
import type { PrepSection } from "./splitter.js";
import type { KpInput } from "./store.js";

/**
 * Course-prep pipeline step 3: reverse coverage audit. For each section the
 * LLM lists verbatim source spans NOT covered by any extracted KP; non-empty
 * gaps trigger one corrective re-extraction of that section. Gaps remaining
 * after the retry are counted honestly in chunk_prep.partialSections —
 * omission becomes visible and countable, never silently accepted.
 */

const AuditResultSchema = z.object({
  uncoveredQuotes: z.array(z.string().min(1)).max(10),
});

const AUDIT_SYSTEM_PROMPT = [
  "你是教材覆盖审计器。给你一个小节原文和已从中抽取的知识点列表。你的唯一任务是找出原文中「没有被任何知识点覆盖」的有信息量片段，只输出一个 JSON 对象。",
  "严格规则：",
  "1. 只输出一个 JSON 对象，形如 {\"uncoveredQuotes\": [...]}，不要输出任何其他文字或代码块标记。",
  "2. uncoveredQuotes：字符串数组（最多 10 条）。每条是原文中一段未被覆盖内容的逐字引用。",
  "3. 「未被覆盖」指：该片段包含定义、原理、方法、因果、数值等教学信息，但没有任何知识点的陈述或证据引文涉及它。",
  "4. 目录式、承接式、重复、过渡性文字不算未覆盖。",
  "5. 全部覆盖时输出空数组。宁可保守（不确定就不列），不得编造原文中不存在的引用。",
].join("\n");

export interface AuditOutcome {
  kps: KpInput[];
  /** Sections still having gaps after the re-extraction retry. */
  partialSections: number;
}

function buildAuditMessages(
  section: PrepSection,
  sectionKps: KpInput[],
): ChatMessage[] {
  const kpList = sectionKps.map((k) => `- ${k.statement}`).join("\n");
  return [
    { role: "system", content: AUDIT_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "小节原文：",
        "---",
        section.content,
        "---",
        "已抽取的知识点：",
        kpList.length > 0 ? kpList : "（无）",
      ].join("\n"),
    },
  ];
}

function parseAudit(raw: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(raw.trim());
  } catch {
    throw new PrepExtractionError("审计失败：LLM 未返回合法 JSON");
  }
  const result = AuditResultSchema.safeParse(json);
  if (!result.success) {
    throw new PrepExtractionError("审计失败：LLM 返回的结构不符合预期格式");
  }
  return result.data.uncoveredQuotes;
}

export interface AuditOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  sections: PrepSection[];
  kps: KpInput[];
  /** Single corrective re-extraction callback for a section with gaps. */
  reextractSection: (section: PrepSection, gaps: string[]) => Promise<KpInput[]>;
}

/**
 * Audits every section. Sections whose gaps survive the re-extraction retry
 * are counted in partialSections. Audit LLM failures do NOT fail the whole
 * prep — an un-auditable section counts as partial (honest degradation with
 * a visible counter, never a silent claim of completeness).
 */
export async function auditCoverage(options: AuditOptions): Promise<AuditOutcome> {
  const kpsBySection = new Map<number, KpInput[]>();
  for (const kp of options.kps) {
    const list = kpsBySection.get(kp.sectionIndex) ?? [];
    list.push(kp);
    kpsBySection.set(kp.sectionIndex, list);
  }

  let partialSections = 0;
  const finalKps = [...options.kps];

  for (const section of options.sections) {
    const sectionKps = kpsBySection.get(section.index) ?? [];
    let gaps: string[];
    try {
      gaps = await parseAuditFor(section, sectionKps, options);
    } catch {
      partialSections += 1;
      continue;
    }
    if (gaps.length === 0) continue;

    // One corrective re-extraction for this section.
    try {
      const reextracted = await options.reextractSection(section, gaps);
      const merged = [...sectionKps, ...reextracted];
      kpsBySection.set(section.index, merged);
      for (const kp of reextracted) finalKps.push(kp);
      // Re-audit the merged section once; surviving gaps count as partial.
      const remaining = await parseAuditFor(section, merged, options);
      if (remaining.length > 0) partialSections += 1;
    } catch {
      partialSections += 1;
    }
  }

  return { kps: finalKps, partialSections };
}

async function parseAuditFor(
  section: PrepSection,
  sectionKps: KpInput[],
  options: Pick<AuditOptions, "baseUrl" | "apiKey" | "model">,
): Promise<string[]> {
  const raw = await requestChatCompletion({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    messages: buildAuditMessages(section, sectionKps),
  });
  // Invalid evidence makes the audit unavailable, not proof of full coverage.
  const parsed = parseAudit(raw);
  if (parsed.some((quote) => !section.content.includes(quote))) {
    throw new PrepExtractionError("审计失败：缺口引文不是小节原文的逐字片段");
  }
  return parsed;
}
