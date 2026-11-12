import { describe, it, expect } from "vitest";
import { renderTranscriptMarkdown } from "../src/export/markdown.js";

describe("renderTranscriptMarkdown", () => {
  it("includes the material title, chunk title, and start time in the header", () => {
    const md = renderTranscriptMarkdown({
      materialTitle: "微积分入门",
      chunkTitle: "第一章 极限",
      startedAt: Date.UTC(2026, 8, 15, 10, 30, 0),
      messages: [],
    });

    expect(md).toContain("# 微积分入门 — 第一章 极限");
    expect(md).toContain("2026-09-15 10:30:00");
  });

  it("shows a placeholder when there are no messages", () => {
    const md = renderTranscriptMarkdown({
      materialTitle: "微积分入门",
      chunkTitle: "第一章 极限",
      startedAt: Date.now(),
      messages: [],
    });

    expect(md).toContain("还没有任何对话记录");
  });

  it("renders each message with its speaker label, timestamp, and content in order", () => {
    const md = renderTranscriptMarkdown({
      materialTitle: "微积分入门",
      chunkTitle: "第一章 极限",
      startedAt: Date.now(),
      messages: [
        {
          role: "user",
          content: "0.999... 不可能等于 1 吧",
          createdAt: Date.UTC(2026, 8, 15, 10, 31, 0),
        },
        {
          role: "assistant",
          content: "先别急。⅓ × 3 等于多少？",
          createdAt: Date.UTC(2026, 8, 15, 10, 31, 5),
        },
      ],
    });

    const userIndex = md.indexOf("0.999... 不可能等于 1 吧");
    const assistantIndex = md.indexOf("先别急。⅓ × 3 等于多少？");

    expect(md).toContain("**我**（2026-09-15 10:31:00）");
    expect(md).toContain("**AI 伙伴**（2026-09-15 10:31:05）");
    expect(userIndex).toBeGreaterThan(-1);
    expect(assistantIndex).toBeGreaterThan(userIndex);
  });
});
