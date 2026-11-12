import { createHash } from "node:crypto";
export interface SourceUnit {
  key: string;
  start: number;
  end: number;
  content: string;
  inputHash: string;
}

/** UTF-16 offsets refer to the unchanged source; no text/Markdown normalization. */
export function splitSourceUnits(source: string, maxChars: number): SourceUnit[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2) throw new Error("maxChars must be an integer >= 2");
  const result: SourceUnit[] = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(start + maxChars, source.length);
    if (end < source.length) {
      const newline = source.lastIndexOf("\n", end - 1);
      if (newline >= start + Math.floor(maxChars / 2)) end = newline + 1;
      const previous = source.charCodeAt(end - 1);
      const next = source.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    }
    const content = source.slice(start, end);
    const inputHash = createHash("sha256").update(content).digest("hex");
    result.push({ key: `${start}:${end}`, start, end, content, inputHash });
    start = end;
  }
  return result;
}
