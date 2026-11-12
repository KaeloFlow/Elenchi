import { describe, it, expect } from "vitest";
import { flashcardsToMarkdown } from "./markdown.js";

describe("flashcardsToMarkdown", () => {
  it("renders a placeholder when there are no cards", () => {
    const md = flashcardsToMarkdown([]);
    expect(md).toContain("还没有生成任何闪卡");
  });

  it("renders question, options, answer, and explanation", () => {
    const md = flashcardsToMarkdown([
      {
        id: "f1",
        sessionId: "s1",
        question: "0.999... 等于多少？",
        options: ["0.999...", "1"],
        answer: "1",
        explanation: "⅓ × 3 = 1",
        createdAt: 1,
      },
    ]);

    expect(md).toContain("## 1. 0.999... 等于多少？");
    expect(md).toContain("- 0.999...");
    expect(md).toContain("- 1");
    expect(md).toContain("**答案**：1");
    expect(md).toContain("**解释**：⅓ × 3 = 1");
  });

  it("omits the options list and explanation line when absent", () => {
    const md = flashcardsToMarkdown([
      {
        id: "f1",
        sessionId: "s1",
        question: "极限是什么？",
        options: null,
        answer: "趋近值",
        explanation: null,
        createdAt: 1,
      },
    ]);

    expect(md).not.toContain("**解释**");
    expect(md).toContain("**答案**：趋近值");
  });

  it("numbers multiple cards sequentially", () => {
    const md = flashcardsToMarkdown([
      { id: "f1", sessionId: "s1", question: "q1", options: null, answer: "a1", explanation: null, createdAt: 1 },
      { id: "f2", sessionId: "s1", question: "q2", options: null, answer: "a2", explanation: null, createdAt: 2 },
    ]);

    expect(md).toContain("## 1. q1");
    expect(md).toContain("## 2. q2");
  });
});
