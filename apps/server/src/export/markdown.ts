/**
 * Renders a session's dialogue transcript as a structured Markdown report
 * (MVP stage 5, product idea 3.2节 "PDF 实录导出" — this module covers the
 * Markdown half of that requirement; the PDF half is a frontend print view).
 *
 * Pure function — no I/O — so it's testable independent of the store/routes
 * that supply its input.
 */

export interface TranscriptContext {
  materialTitle: string;
  chunkTitle: string;
  startedAt: number;
  messages: { role: "user" | "assistant"; content: string; createdAt: number }[];
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function renderTranscriptMarkdown(ctx: TranscriptContext): string {
  const lines = [
    `# ${ctx.materialTitle} — ${ctx.chunkTitle}`,
    "",
    `课堂开始时间：${formatTimestamp(ctx.startedAt)}`,
    "",
    "---",
    "",
  ];

  if (ctx.messages.length === 0) {
    lines.push("（本堂课还没有任何对话记录）");
  } else {
    for (const message of ctx.messages) {
      const speaker = message.role === "user" ? "我" : "AI 伙伴";
      lines.push(`**${speaker}**（${formatTimestamp(message.createdAt)}）`, "", message.content, "");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}
