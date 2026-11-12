import type { FlashcardDto } from "@elenchi/shared";

/**
 * Renders a flashcard list as Markdown for export (product idea 3.2节:
 * "支持导出为 Markdown 格式"). Pure function so it's testable without a
 * DOM/download dependency; the caller (FlashcardsPanel) turns the string
 * into a downloadable file.
 */
export function flashcardsToMarkdown(cards: FlashcardDto[]): string {
  if (cards.length === 0) {
    return "# 闪卡\n\n（还没有生成任何闪卡）\n";
  }

  const sections = cards.map((card, index) => {
    const lines = [`## ${index + 1}. ${card.question}`, ""];
    if (card.options && card.options.length > 0) {
      lines.push(...card.options.map((opt) => `- ${opt}`), "");
    }
    lines.push(`**答案**：${card.answer}`);
    if (card.explanation) {
      lines.push("", `**解释**：${card.explanation}`);
    }
    return lines.join("\n");
  });

  return ["# 闪卡", "", ...sections].join("\n\n") + "\n";
}
