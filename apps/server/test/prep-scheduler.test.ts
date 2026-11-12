import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  scheduleLessons,
  validateProposal,
  greedyPack,
  LESSON_CAPACITY,
} from "../src/prep/scheduler.js";
import type { KpInput } from "../src/prep/store.js";
import * as client from "../src/dialogue/client.js";

vi.mock("../src/dialogue/client.js", () => ({
  requestChatCompletion: vi.fn(),
}));

const mockRequest = vi.mocked(client.requestChatCompletion);

function mkKps(count: number, sectionsPerLesson = 5): KpInput[] {
  return Array.from({ length: count }, (_, i) => ({
    statement: `KP ${i + 1}`,
    type: "concept" as const,
    sectionIndex: Math.floor(i / sectionsPerLesson),
    sectionTitle: `节 ${Math.floor(i / sectionsPerLesson) + 1}`,
    evidence: ["evidence"],
  }));
}

function proposalJson(
  lessons: { title: string; objective: string; kpIndices: number[] }[],
): string {
  return JSON.stringify({ lessons });
}

beforeEach(() => {
  mockRequest.mockReset();
});

describe("validateProposal", () => {
  it("accepts a valid covering ordered proposal", () => {
    const violations = validateProposal(
      [
        { title: "a", objective: "o", kpIndices: [0, 1, 2] },
        { title: "b", objective: "o", kpIndices: [3, 4, 5] },
      ],
      6,
    );
    expect(violations).toEqual([]);
  });

  it("flags omission, duplication, disorder and capacity", () => {
    const violations = validateProposal(
      [
        { title: "a", objective: "o", kpIndices: [0, 1, 1] },
        { title: "b", objective: "o", kpIndices: [4, 3] },
      ],
      6,
    );
    expect(violations.some((v) => v.includes("重复"))).toBe(true);
    expect(violations.some((v) => v.includes("未分配"))).toBe(true);
    expect(violations.some((v) => v.includes("文档顺序"))).toBe(true);
    expect(violations.some((v) => v.includes("容量"))).toBe(true);
  });

  it("allows a single lesson shorter than the min capacity", () => {
    const violations = validateProposal(
      [{ title: "a", objective: "o", kpIndices: [0, 1] }],
      2,
    );
    expect(violations).toEqual([]);
  });
});

describe("greedyPack", () => {
  it("never drops or reorders and respects the hard bounds", () => {
    const kps = mkKps(17, 5);
    const lessons = greedyPack(kps);
    const flat = lessons.flatMap((l) => l.kpIndices);
    expect(flat).toEqual(kps.map((_, i) => i));
    for (const lesson of lessons) {
      expect(lesson.kpIndices.length).toBeLessThanOrEqual(LESSON_CAPACITY.max);
    }
  });

  it("prefers section boundaries once the target size is met", () => {
    const kps = mkKps(10, 5); // two sections of 5
    const lessons = greedyPack(kps);
    expect(lessons.map((l) => l.kpIndices)).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8, 9],
    ]);
  });

  it("rebalances a trailing sub-min group without exceeding the max", () => {
    const lessons = greedyPack(mkKps(8, 8));
    expect(lessons.map((lesson) => lesson.kpIndices)).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7],
    ]);
    expect(lessons.every((lesson) => lesson.kpIndices.length <= LESSON_CAPACITY.max)).toBe(true);
  });

  it("keeps every non-small-chapter lesson within 3–7 KPs", () => {
    for (const count of [8, 9, 15]) {
      const lessons = greedyPack(mkKps(count, count));
      expect(lessons.flatMap((lesson) => lesson.kpIndices)).toEqual(
        Array.from({ length: count }, (_, index) => index),
      );
      expect(
        lessons.every(
          (lesson) =>
            lesson.kpIndices.length >= LESSON_CAPACITY.min &&
            lesson.kpIndices.length <= LESSON_CAPACITY.max,
        ),
      ).toBe(true);
    }
  });

  it("returns a single lesson for a small chapter", () => {
    const lessons = greedyPack(mkKps(2));
    expect(lessons).toHaveLength(1);
  });

  it("returns empty for no KPs", () => {
    expect(greedyPack([])).toEqual([]);
  });
});

describe("scheduleLessons", () => {
  it("returns the LLM proposal when it validates", async () => {
    mockRequest.mockResolvedValueOnce(
      proposalJson([
        { title: "第 1 课", objective: "o", kpIndices: [0, 1, 2] },
        { title: "第 2 课", objective: "o", kpIndices: [3, 4, 5] },
      ]),
    );
    const result = await scheduleLessons({
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      kps: mkKps(6),
    });
    expect(result.autoPackedCount).toBe(0);
    expect(result.lessons).toHaveLength(2);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("retries once on violation then falls back to the greedy packer", async () => {
    mockRequest
      .mockResolvedValueOnce(
        proposalJson([{ title: "x", objective: "o", kpIndices: [0, 1] }]),
      )
      .mockResolvedValueOnce(
        proposalJson([{ title: "y", objective: "o", kpIndices: [0] }]),
      );
    const result = await scheduleLessons({
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      kps: mkKps(6),
    });
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(result.autoPackedCount).toBeGreaterThan(0);
    const flat = result.lessons.flatMap((l) => l.kpIndices);
    expect(flat).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("falls back when both responses are unparseable", async () => {
    mockRequest.mockResolvedValueOnce("garbage").mockResolvedValueOnce("garbage");
    const result = await scheduleLessons({
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      kps: mkKps(6),
    });
    expect(result.autoPackedCount).toBeGreaterThan(0);
    expect(result.lessons.flatMap((l) => l.kpIndices)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
