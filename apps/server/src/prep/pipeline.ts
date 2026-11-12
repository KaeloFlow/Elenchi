import { getChunkById } from "../materials/store.js";
import { readSettings } from "../settings/store.js";
import type { ServerConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { extractKnowledgePoints, PrepExtractionError } from "./extractor.js";
import { auditCoverage } from "./auditor.js";
import { scheduleLessons } from "./scheduler.js";
import { splitSections } from "./splitter.js";
import {
  insertPrepResults,
  recordPrepFailure,
  getChunkPrep,
} from "./store.js";
import type { PrepSection } from "./splitter.js";
import type { KpInput } from "./store.js";

/**
 * Course-prep pipeline orchestration (lazy, one chapter per run):
 * split → extract → audit → schedule → persist, all-or-nothing per step.
 * Failures are recorded on chunk_prep as status=failed (retryable via a
 * clean full-chapter re-run); success stores KP + lesson rows atomically.
 */

/** In-process concurrency guard (single-user local app). */
const inFlight = new Set<string>();

export class PrepInProgressError extends Error {
  constructor(chunkId: string) {
    super(`该章正在备课中: ${chunkId}`);
    this.name = "PrepInProgressError";
  }
}

export interface PrepareChunkResult {
  status: "ready" | "failed";
  kpCount: number;
  lessonCount: number;
  partialSections: number;
  autoPackedLessons: number;
  error: string | null;
}

/**
 * Runs the full prep pipeline for one chapter. `chapterLevel` is the
 * markdown heading depth of the chunk's own boundary heading (0 for the
 * leading chunk). Already-ready chapters are no-ops (idempotent); failed
 * chapters re-run from scratch.
 */
export async function prepareChunk(
  db: Db,
  config: ServerConfig,
  chunkId: string,
): Promise<PrepareChunkResult> {
  const chunk = getChunkById(db, chunkId);
  if (!chunk) {
    throw new Error(`章节不存在: ${chunkId}`);
  }

  const existing = getChunkPrep(db, chunkId);
  if (existing?.status === "ready") {
    return toResult(existing);
  }
  if (inFlight.has(chunkId)) {
    throw new PrepInProgressError(chunkId);
  }
  inFlight.add(chunkId);

  try {
    const settings = readSettings(config.dataDir);
    if (!settings) {
      throw new Error("LLM 未配置，无法备课");
    }

    const llm = {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
    };
    const chapterLevel = chunk.level;

    // Step 1: deterministic sectioning.
    const sections = splitSections(chunk.content, chapterLevel);
    if (sections.length === 0) {
      throw new Error("该章没有可抽取的内容");
    }

    // Step 2: KP extraction with verbatim evidence validation.
    let kps: KpInput[];
    try {
      kps = await extractKnowledgePoints({ ...llm, sections });
    } catch (err) {
      throw new Error(
        err instanceof PrepExtractionError
          ? err.message
          : `抽取失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (kps.length === 0) {
      throw new Error("抽取结果为空：本章没有识别出任何知识点");
    }

    // Step 3: reverse coverage audit (per-section gaps → one re-extract).
    const audit = await auditCoverage({
      ...llm,
      sections,
      kps,
      reextractSection: (section: PrepSection, gaps: string[]) =>
        reextractSectionKps({ ...llm }, section, gaps),
    });
    kps = audit.kps;

    // Step 4: lesson scheduling (LLM proposal → greedy fallback).
    const schedule = await scheduleLessons({ ...llm, kps });

    // Step 5: persist atomically.
    insertPrepResults(db, {
      chunkId,
      materialId: chunk.materialId,
      kps,
      lessons: schedule.lessons.map((l) => ({
        title: l.title,
        objective: l.objective,
        kpIndices: l.kpIndices,
        autoPacked: l.autoPacked,
      })),
      partialSections: audit.partialSections,
      autoPackedLessons: schedule.autoPackedCount,
    });

    const stored = getChunkPrep(db, chunkId)!;
    return toResult(stored);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordPrepFailure(db, { chunkId, materialId: chunk.materialId, error: message });
    return {
      status: "failed",
      kpCount: 0,
      lessonCount: 0,
      partialSections: 0,
      autoPackedLessons: 0,
      error: message,
    };
  } finally {
    inFlight.delete(chunkId);
  }
}

async function reextractSectionKps(
  llm: { baseUrl: string; apiKey: string; model: string },
  section: PrepSection,
  gaps: string[],
): Promise<KpInput[]> {
  // Re-run extraction for this one section with the gap list called out.
  // The audit only ever passes gaps that are verbatim substrings of the real
  // section content, so every honest evidence quote still anchors to the
  // original text; the final filter enforces exactly that.
  try {
    const kps = await extractKnowledgePoints({
      ...llm,
      sections: [
        {
          ...section,
          content: `${section.content}\n\n【审计发现的未覆盖片段，请务必为其抽取知识点】\n${gaps.join("\n")}`,
        },
      ],
    });
    return kps.filter(
      (kp) =>
        kp.sectionIndex === section.index &&
        kp.evidence.length > 0 &&
        kp.evidence.every((e) => section.content.includes(e)),
    );
  } catch {
    return [];
  }
}

function toResult(row: {
  status: "ready" | "failed";
  kpCount: number;
  lessonCount: number;
  partialSections: number;
  autoPackedLessons: number;
  error: string | null;
}): PrepareChunkResult {
  return {
    status: row.status,
    kpCount: row.kpCount,
    lessonCount: row.lessonCount,
    partialSections: row.partialSections,
    autoPackedLessons: row.autoPackedLessons,
    error: row.error,
  };
}
