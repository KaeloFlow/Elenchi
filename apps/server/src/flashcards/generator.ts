import { ExtractedFlashcardsSchema, type ExtractedFlashcard } from "@elenchi/shared";
import { requestChatCompletion, type ChatMessage } from "../dialogue/client.js";

export interface FlashcardExtractionContext {
  materialTitle: string;
  chunkTitle: string;
  history: { role: "user" | "assistant"; content: string }[];
}

const EXTRACTION_SYSTEM_PROMPT = [
  "你是一个知识点提取助手。给定一段师生对话记录，从中提取值得复习的知识点，",
  "生成简体中文闪卡。",
  "",
  "严格规则：",
  '1. 只输出一个 JSON 对象，格式为 {"flashcards": [{"question": string, ' +
    '"options": string[] | null, "answer": string, "explanation": string | null}, ...]}。',
  "2. 不要输出 JSON 之外的任何文字、markdown 代码块标记或解释。",
  "3. 每张闪卡的 question 必须能独立理解，不依赖对话上下文。",
  "4. 如果对话中出现了具体的选择或判断（比如用户曾经的错误认知与最终结论），" +
    "可以把 options 设为几个候选答案；如果知识点是开放式的，options 设为 null。",
  "5. answer 必须是对话中实际得出的结论，不要编造对话之外的内容。",
  "6. 如果这段对话没有产生任何值得记忆的知识点，返回 {\"flashcards\": []}。",
].join("\n");

function buildExtractionMessages(ctx: FlashcardExtractionContext): ChatMessage[] {
  const transcript = ctx.history
    .map((m) => `${m.role === "user" ? "学生" : "AI 伙伴"}：${m.content}`)
    .join("\n");

  return [
    { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `教材：《${ctx.materialTitle}》 — 章节：${ctx.chunkTitle}`,
        "",
        "对话记录：",
        transcript,
      ].join("\n"),
    },
  ];
}

/**
 * Strips a ```json ... ``` or ``` ... ``` fence if the model wrapped its
 * output despite the system prompt's instruction not to. Best-effort only —
 * if there's no fence, the input is returned unchanged.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

export interface ExtractFlashcardsOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  context: FlashcardExtractionContext;
}

/**
 * Calls the LLM once (non-streaming) with an extraction-only prompt and
 * parses+validates its JSON response. Throws with a descriptive message on
 * malformed output instead of silently persisting a broken card — the
 * caller (flashcards/routes.ts) surfaces this as a 502 to the client.
 */
export async function extractFlashcards(
  options: ExtractFlashcardsOptions,
): Promise<ExtractedFlashcard[]> {
  const raw = await requestChatCompletion({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    messages: buildExtractionMessages(options.context),
  });

  const candidate = stripCodeFence(raw);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch {
    throw new Error("闪卡提取失败：LLM 未返回合法的 JSON");
  }

  const result = ExtractedFlashcardsSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error("闪卡提取失败：LLM 返回的结构不符合预期格式");
  }

  return result.data.flashcards;
}
