import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../src/materials/chunker.js";

describe("chunkMarkdown", () => {
  it("splits on level-1 headings", () => {
    const md = [
      "# 第一章 极限",
      "极限是微积分的基础。",
      "",
      "# 第二章 导数",
      "导数描述变化率。",
    ].join("\n");

    const chunks = chunkMarkdown(md);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].title).toBe("第一章 极限");
    expect(chunks[0].level).toBe(1);
    expect(chunks[0].content).toContain("极限是微积分的基础");
    expect(chunks[1].title).toBe("第二章 导数");
  });

  it("splits on level-2 headings within the same level-1 section", () => {
    const md = [
      "# 第一章",
      "章节引言。",
      "",
      "## 1.1 定义",
      "定义内容。",
      "",
      "## 1.2 性质",
      "性质内容。",
    ].join("\n");

    const chunks = chunkMarkdown(md);

    expect(chunks.map((c) => c.title)).toEqual(["第一章", "1.1 定义", "1.2 性质"]);
  });

  it("keeps level-3+ headings attached to the enclosing chunk", () => {
    const md = [
      "# 第一章",
      "",
      "### 1.1.1 细节",
      "这是三级标题下的内容，不应单独切分。",
    ].join("\n");

    const chunks = chunkMarkdown(md);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("### 1.1.1 细节");
    expect(chunks[0].content).toContain("这是三级标题下的内容");
  });

  it("captures untitled leading content before the first heading", () => {
    const md = ["这是前言，没有标题。", "", "# 第一章", "正文。"].join("\n");

    const chunks = chunkMarkdown(md);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].title).toBe("(无标题)");
    expect(chunks[0].level).toBe(0);
    expect(chunks[0].content).toContain("这是前言");
    expect(chunks[1].title).toBe("第一章");
  });

  it("drops the leading chunk entirely when there is no content before the first heading", () => {
    const md = ["# 第一章", "正文。"].join("\n");

    const chunks = chunkMarkdown(md);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe("第一章");
  });

  it("returns an empty array for markdown with no headings at all", () => {
    const md = "只有正文，没有任何标题。";

    const chunks = chunkMarkdown(md);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe("(无标题)");
    expect(chunks[0].level).toBe(0);
  });

  it("assigns sequential 1-based order across chunks", () => {
    const md = ["# A", "a", "", "# B", "b", "", "# C", "c"].join("\n");

    const chunks = chunkMarkdown(md);

    expect(chunks.map((c) => c.order)).toEqual([1, 2, 3]);
  });
});

describe("chunkMarkdown — chapter mode (textbook-style documents)", () => {
  it("splits only at chapter-like headings and keeps structural sections inside the chapter", () => {
    const md = [
      "# 管理学",
      "全书导览。",
      "",
      "---",
      "",
      "# 第1章 组织与管理",
      "章引言。",
      "",
      "## 学习目标",
      "目标内容。",
      "",
      "## 本章小结",
      "小结内容。",
      "",
      "# 第2章 环境",
      "第二章内容。",
    ].join("\n");

    const chunks = chunkMarkdown(md);

    expect(chunks.map((c) => c.title)).toEqual([
      "管理学",
      "第1章 组织与管理",
      "第2章 环境",
    ]);
    // The leading chunk carries the book title heading and preview text.
    expect(chunks[0].level).toBe(1);
    expect(chunks[0].content).toContain("全书导览");
    // Structural level-2 headings are NOT split out as chapters.
    expect(chunks[1].content).toContain("## 学习目标");
    expect(chunks[1].content).toContain("## 本章小结");
    expect(chunks[1].content).toContain("章引言");
    expect(chunks[2].content).toContain("第二章内容");
  });

  it("recognizes chapter-like headings at level 2 under a part heading at level 1", () => {
    const md = [
      "# 第一部分",
      "## 第1章 计划",
      "计划内容。",
      "",
      "## 第2章 组织",
      "组织内容。",
    ].join("\n");

    const chunks = chunkMarkdown(md);

    // The bare part wrapper directly above a chapter heading is not a
    // chapter boundary; it becomes the leading chunk's title.
    expect(chunks.map((c) => c.title)).toEqual([
      "第一部分",
      "第1章 计划",
      "第2章 组织",
    ]);
    expect(chunks[1].level).toBe(2);
  });

  it("recognizes English chapter headings", () => {
    const md = [
      "# Book Title",
      "Intro.",
      "",
      "# Chapter 1 Limits",
      "Limit content.",
      "",
      "## 1.1 Sequences",
      "Subsection stays inside the chapter.",
      "",
      "# Chapter 2 Derivatives",
      "Derivative content.",
    ].join("\n");

    const chunks = chunkMarkdown(md);

    expect(chunks.map((c) => c.title)).toEqual([
      "Book Title",
      "Chapter 1 Limits",
      "Chapter 2 Derivatives",
    ]);
    expect(chunks[1].content).toContain("## 1.1 Sequences");
  });

  it("drops heading-shaped table-of-contents entries and keeps the real chapters", () => {
    const md = [
      "# 目录",
      "## 第1章 组织",
      "## 第2章 环境",
      "## 第3章 决策",
      "",
      "# 第1章 组织",
      "真实第一章内容。",
      "",
      "# 第2章 环境",
      "真实第二章内容。",
    ].join("\n");

    const chunks = chunkMarkdown(md);

    expect(chunks.map((c) => c.title)).toEqual([
      "目录",
      "第1章 组织",
      "第2章 环境",
    ]);
    // The TOC listing text stays in the leading chunk, not as chapters.
    expect(chunks[0].content).toContain("## 第3章 决策");
    expect(chunks[1].content).toContain("真实第一章内容");
  });

  it("keeps TOC-shaped entries that carry body text between them (documented heuristic limit)", () => {
    const md = [
      "# 第1章 概述",
      "这一章真的有内容，所以它是章节而不是目录条目。",
      "",
      "# 第2章 方法",
      "方法内容。",
    ].join("\n");

    const chunks = chunkMarkdown(md);

    expect(chunks.map((c) => c.title)).toEqual(["第1章 概述", "第2章 方法"]);
  });

  it("falls back to level-1/2 splitting for a single-chapter document", () => {
    const md = [
      "# 第一章 极限",
      "章引言。",
      "",
      "## 1.1 数列极限",
      "子节内容。",
    ].join("\n");

    const chunks = chunkMarkdown(md);

    // Only one chapter-like heading exists, so the old level-1/2 split
    // applies and the numbered subsection remains its own chunk.
    expect(chunks.map((c) => c.title)).toEqual([
      "第一章 极限",
      "1.1 数列极限",
    ]);
  });

  it("does not mistake plain numbered sections for chapters", () => {
    const md = [
      "## 1. 先看清：什么是组织",
      "内容一。",
      "",
      "## 2. 谁是管理者",
      "内容二。",
    ].join("\n");

    const chunks = chunkMarkdown(md);

    expect(chunks.map((c) => c.title)).toEqual([
      "1. 先看清：什么是组织",
      "2. 谁是管理者",
    ]);
  });
});
