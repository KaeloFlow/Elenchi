import { unified } from "unified";
import remarkParse from "remark-parse";
import { toString as mdastToString } from "mdast-util-to-string";
import type { Root, RootContent, Heading } from "mdast";

/**
 * A single chunk of a parsed markdown material, anchored to a heading.
 *
 * Split strategy:
 * when the document contains chapter-like headings (第1章 / Chapter 2 / ...),
 * chunks are real chapter units and all deeper structure stays inside the
 * chapter chunk. Documents without chapter-like headings fall back to the
 * original level-1/2 split.
 */
export interface MaterialChunk {
  /** 1-based order within the material. */
  order: number;
  /**
   * Boundary heading text. The leading chunk (content before the first
   * boundary) takes its title from the first heading it contains — usually
   * the book title — or "(无标题)" when it has no heading at all.
   */
  title: string;
  /** Heading depth of the boundary heading; 0 for a heading-less leading chunk. */
  level: number;
  /** Original markdown source for this chunk (heading line included). */
  content: string;
}

/** Fallback split levels for documents without chapter-like headings. */
const FALLBACK_HEADING_LEVELS = new Set([1, 2]);

/**
 * Chapter-like heading titles: "第1章 组织与管理", "第十二章", "第 3 讲",
 * "第一单元", "Chapter 2", "Unit IV", "Lesson 5", "Module 1" (arabic,
 * chinese or roman numerals). Matched regardless of heading depth, because
 * converted textbooks use markdown heading levels inconsistently (chapters
 * sometimes sit at `##` under a book/part `#` title).
 */
const CHAPTER_TITLE_RE =
  /^(?:第\s*[0-9零一二三四五六七八九十百千]+\s*(?:[章篇部讲回课]|单元)|(?:chapter|unit|lesson|module)\s+(?:[0-9]+|[ivxlcdm]+)\b)/i;

interface HeadingInfo {
  heading: Heading;
  /** 0-based start line of the heading in the source. */
  startLine: number;
  /** 0-based end line (inclusive) of the heading in the source. */
  endLine: number;
  text: string;
}

function headingText(node: Heading): string {
  return mdastToString(node).trim() || "(无标题)";
}

function collectHeadings(tree: Root): HeadingInfo[] {
  const infos: HeadingInfo[] = [];
  for (const node of tree.children as RootContent[]) {
    if (node.type === "heading" && node.position) {
      infos.push({
        heading: node,
        startLine: node.position.start.line - 1,
        endLine: node.position.end.line - 1,
        text: mdastToString(node).trim(),
      });
    }
  }
  return infos;
}

function hasBodyBetween(lines: string[], a: HeadingInfo, b: HeadingInfo): boolean {
  return lines
    .slice(a.endLine + 1, b.startLine)
    .some((line) => line.trim().length > 0);
}

/**
 * Real chapter boundaries: chapter-like headings that do not belong to a
 * heading-shaped table of contents. A chapter-like heading immediately
 * followed by another chapter-like heading with no body text in between is
 * a TOC listing entry (or a bare part wrapper such as "# 第一部分" directly
 * above "# 第1章"), not a chapter boundary, so it is skipped.
 */
function selectChapterBoundaries(
  headings: HeadingInfo[],
  lines: string[],
): HeadingInfo[] {
  const boundaries: HeadingInfo[] = [];
  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    if (!CHAPTER_TITLE_RE.test(current.text)) continue;
    const next = headings[i + 1];
    if (
      next &&
      CHAPTER_TITLE_RE.test(next.text) &&
      !hasBodyBetween(lines, current, next)
    ) {
      continue;
    }
    boundaries.push(current);
  }
  return boundaries;
}

/**
 * Splits markdown source into chapter chunks.
 *
 * Chapter mode (>= 2 real chapter-like headings): split only at those
 * headings, whatever their markdown depth; sub-section headings and body
 * text stay attached to their chapter. Fallback mode: split at level-1 and
 * level-2 headings as before. In both modes, content before the first
 * boundary becomes a leading chunk (dropped if empty) whose title comes
 * from the first heading it contains — for textbooks usually the book
 * title.
 */
export function chunkMarkdown(source: string): MaterialChunk[] {
  const tree = unified().use(remarkParse).parse(source) as Root;
  const lines = source.split("\n");
  const headings = collectHeadings(tree);

  const chapterBoundaries = selectChapterBoundaries(headings, lines);
  const boundaries =
    chapterBoundaries.length >= 2
      ? chapterBoundaries
      : headings.filter((h) =>
          FALLBACK_HEADING_LEVELS.has(h.heading.depth),
        );

  const chunks: MaterialChunk[] = [];
  let order = 1;

  const leadingEnd =
    boundaries.length > 0 ? boundaries[0].startLine : lines.length;
  const leadingText = lines.slice(0, leadingEnd).join("\n").trim();
  if (leadingText.length > 0) {
    const leadHeading = headings.find((h) => h.startLine < leadingEnd);
    chunks.push({
      order: order++,
      title: leadHeading ? headingText(leadHeading.heading) : "(无标题)",
      level: leadHeading ? leadHeading.heading.depth : 0,
      content: leadingText,
    });
  }

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].startLine;
    const end =
      i + 1 < boundaries.length ? boundaries[i + 1].startLine : lines.length;
    const content = lines.slice(start, end).join("\n").trim();
    chunks.push({
      order: order++,
      title: headingText(boundaries[i].heading),
      level: boundaries[i].heading.depth,
      content,
    });
  }

  return chunks;
}
