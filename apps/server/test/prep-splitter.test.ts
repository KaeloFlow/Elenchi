import { describe, it, expect } from "vitest";
import { splitSections } from "../src/prep/splitter.js";

/**
 * Conservation check: every non-heading source line must appear in exactly
 * the union of section contents, except the chapter's own title line. This
 * is the constructive-completeness guarantee from the design spec §7.1,
 * asserted independently of the splitter's own slicing logic.
 */
function assertLineConservation(
  chapterContent: string,
  chapterLevel: number,
): void {
  const sections = splitSections(chapterContent, chapterLevel);
  const sectionLines = sections
    .flatMap((s) => s.content.split("\n"))
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const lines = chapterContent.split("\n");
  const excluded = new Set<string>();
  if (chapterLevel > 0 && lines.length > 0) {
    const titleRe = new RegExp(`^${"#".repeat(chapterLevel)}\\s`);
    if (titleRe.test(lines[0]!)) excluded.add(lines[0]!.trim());
  }
  const sourceLines = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !excluded.has(l));
  const sectionSet = new Set(sectionLines);
  for (const line of sourceLines) {
    expect(sectionSet.has(line)).toBe(true);
  }
  // No foreign lines: every section line exists in the source.
  const sourceSet = new Set(sourceLines);
  for (const line of sectionLines) {
    expect(sourceSet.has(line)).toBe(true);
  }
}

describe("splitSections", () => {
  it("splits a chapter at its immediate sub-level headings", () => {
    const chapter = [
      "# 第1章 极限",
      "本章讲极限。",
      "## 1.1 数列极限",
      "数列极限的定义如下。",
      "## 1.2 函数极限",
      "函数极限类似。",
    ].join("\n");
    const sections = splitSections(chapter, 1);
    expect(sections.map((s) => s.title)).toEqual([
      "章节导语",
      "1.1 数列极限",
      "1.2 函数极限",
    ]);
    expect(sections[0]!.content).toBe("本章讲极限。");
    expect(sections[1]!.content).toContain("1.1 数列极限");
    expect(sections[1]!.content).toContain("数列极限的定义如下。");
    assertLineConservation(chapter, 1);
  });

  it("keeps deeper-than-D headings inside their section", () => {
    const chapter = [
      "# 第2章 导数",
      "## 2.1 定义",
      "### 几何意义",
      "切线斜率。",
      "## 2.2 运算法则",
      "四则运算法则。",
    ].join("\n");
    const sections = splitSections(chapter, 1);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.content).toContain("### 几何意义");
    expect(sections[0]!.content).toContain("切线斜率。");
    assertLineConservation(chapter, 1);
  });

  it("folds a TOC-shell heading into the next section content", () => {
    const chapter = [
      "# 第3章 积分",
      "## 3.1 不定积分",
      "## 3.2 定积分",
      "定积分的定义。",
    ].join("\n");
    const sections = splitSections(chapter, 1);
    // 3.1 has no body and folds away; 3.2 carries the only body.
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("3.2 定积分");
    expect(sections[0]!.content).toContain("3.1 不定积分");
    expect(sections[0]!.content).toContain("定积分的定义。");
    assertLineConservation(chapter, 1);
  });

  it("folds a trailing shell heading into the previous section title", () => {
    const chapter = [
      "# 第4章 级数",
      "## 4.1 收敛",
      "级数收敛的定义。",
      "## 4.2 判别法",
    ].join("\n");
    const sections = splitSections(chapter, 1);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("4.1 收敛 — 4.2 判别法");
    expect(sections[0]!.content).toContain("4.2 判别法");
    assertLineConservation(chapter, 1);
  });

  it("uses the shallowest deeper level as D (fallback-mode H1+H3)", () => {
    const chapter = [
      "# 第5章 微分方程",
      "### 5.a 一阶",
      "一阶方程。",
      "### 5.b 二阶",
      "二阶方程。",
    ].join("\n");
    const sections = splitSections(chapter, 1);
    expect(sections.map((s) => s.title)).toEqual(["5.a 一阶", "5.b 二阶"]);
    assertLineConservation(chapter, 1);
  });

  it("returns a single section for a chapter without deeper headings", () => {
    const chapter = "# 第6章 总结\n本章内容无子标题。";
    const sections = splitSections(chapter, 1);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.content).toBe("本章内容无子标题。");
    assertLineConservation(chapter, 1);
  });

  it("keeps pre-heading content of a leading chunk as the intro section", () => {
    const chapter = ["前言", "## 序", "这本书讲什么。", "## 凡例", "体例说明。"].join(
      "\n",
    );
    const sections = splitSections(chapter, 0);
    expect(sections.map((s) => s.title)).toEqual([
      "章节导语",
      "序",
      "凡例",
    ]);
    expect(sections[0]!.content).toBe("前言");
    assertLineConservation(chapter, 0);
  });

  it("returns empty for an empty chapter body", () => {
    expect(splitSections("# 第7章 空章", 1)).toEqual([]);
  });

  it("respects a deeper chapter level (H2 chapter with no H3 -> single section)", () => {
    const chapter = [
      "## 上篇",
      "## 第一章 引言",
      "引言正文。",
      "## 第二章 方法",
      "方法正文。",
    ].join("\n");
    const sections = splitSections(chapter, 2);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.content).toContain("引言正文。");
    assertLineConservation(chapter, 2);
  });
});
