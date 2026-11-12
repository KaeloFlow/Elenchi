import { unified } from "unified";
import remarkParse from "remark-parse";
import { toString as mdastToString } from "mdast-util-to-string";
import type { Root, RootContent, Heading } from "mdast";

/**
 * Deterministic sectioning of one chapter chunk (course-prep pipeline step 1).
 *
 * Completeness is constructive: section start/end lines are derived from
 * heading line positions, so every line of the chunk belongs to exactly one
 * section, except the chapter's own title line which no section holds.
 * Pure function — no LLM, no I/O.
 */

export interface PrepSection {
  /** 0-based index within the chapter. */
  index: number;
  /** Section title; TOC-shell headings are folded in as title suffixes. */
  title: string;
  /** Section body including its boundary heading line, trimmed. */
  content: string;
}

interface HeadingInfo {
  heading: Heading;
  /** 0-based start line of the heading in the source. */
  startLine: number;
  /** 0-based end line (inclusive) of the heading in the source. */
  endLine: number;
  text: string;
  depth: number;
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
        depth: node.depth,
      });
    }
  }
  return infos;
}

/**
 * Section boundary depth D = the shallowest heading depth strictly deeper
 * than the chapter level L that actually exists in the chunk. Covers both
 * chapter mode (chapter H1 with H2 sections -> D=2) and fallback mode
 * (chapter H1 where only H3s remain -> D=3).
 */
function resolveBoundaryDepth(
  headings: HeadingInfo[],
  chapterLevel: number,
): number | null {
  let best: number | null = null;
  for (const h of headings) {
    if (h.depth > chapterLevel && (best === null || h.depth < best)) {
      best = h.depth;
    }
  }
  return best;
}

/**
 * Splits chapter content into sections. `chapterLevel` is the markdown depth
 * of the chapter's own boundary heading (0 for a leading chunk without a
 * chapter-shaped heading). The chapter title line belongs to no section; the
 * text between it and the first D-level heading becomes the "章节导语"
 * section. A chunk with no deeper headings is a single section.
 */
export function splitSections(
  chapterContent: string,
  chapterLevel: number,
): PrepSection[] {
  const lines = chapterContent.split("\n");
  const tree = unified().use(remarkParse).parse(chapterContent) as Root;
  const headings = collectHeadings(tree);
  const depth = resolveBoundaryDepth(headings, chapterLevel);

  // No deeper headings: one section holding everything after the title line.
  if (depth === null) {
    const firstHeading = headings[0];
    const start = firstHeading ? firstHeading.endLine + 1 : 0;
    const content = lines.slice(start).join("\n").trim();
    if (content.length === 0) return [];
    return [{ index: 0, title: "章节导语", content }];
  }

  const boundaries = headings.filter((h) => h.depth === depth);
  const sections: PrepSection[] = [];

  // Intro: after the chapter title line, before the first boundary.
  const chapterTitleEnd =
    chapterLevel > 0 && headings[0]?.depth === chapterLevel
      ? headings[0]!.endLine
      : -1;
  const introEnd = boundaries[0]!.startLine;
  const intro = lines
    .slice(chapterTitleEnd + 1, introEnd)
    .join("\n")
    .trim();
  if (intro.length > 0) {
    sections.push({ index: 0, title: "章节导语", content: intro });
  }

  // Body sections. A boundary heading with no body before the next boundary
  // is a TOC-style shell: its heading line folds into the next section's
  // content and, when it is the last boundary, its title folds into the
  // previous section's title — no line is ever dropped.
  let pendingShells: string[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const current = boundaries[i]!;
    const next = boundaries[i + 1];
    const end = next ? next.startLine : lines.length;
    const withHeading = lines.slice(current.startLine, end).join("\n").trim();
    const body = lines.slice(current.endLine + 1, end).join("\n").trim();
    if (body.length === 0) {
      if (next) {
        pendingShells.push(withHeading);
      } else if (sections.length > 0) {
        const last = sections[sections.length - 1]!;
        last.title = `${last.title} — ${current.text}`;
        last.content = `${last.content}\n\n${withHeading}`;
      }
      continue;
    }
    const shellPrefix =
      pendingShells.length > 0 ? pendingShells.join("\n\n") + "\n\n" : "";
    pendingShells = [];
    sections.push({
      index: sections.length,
      title: current.text,
      content: shellPrefix + withHeading,
    });
  }

  return sections;
}
