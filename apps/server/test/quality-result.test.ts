import { describe, expect, it } from "vitest";
import { buildQualityResult } from "../src/prep/quality-result.js";
const point = (type: string, n: number) => ({ statement: `命题${n}`, type: type as never, evidence: ["原文"], conditions: [], exceptions: [] });
describe("quality result assembly", () => {
  it("orders checkpoint units, creates stable local ids, and schedules every point", () => {
    const result = buildQualityResult([
      { sourceStart: 10, sourceEnd: 20, points: [point("concept", 2)] },
      { sourceStart: 0, sourceEnd: 10, points: [point("formula", 1), point("fact", 3)] },
    ], "小节");
    expect(result.kps.map((kp) => kp.statement)).toEqual(["命题1", "命题3", "命题2"]);
    expect(result.lessons.flatMap((lesson) => lesson.kpIds)).toEqual(result.kps.map((kp) => kp.id));
    expect(result.sourceCoverage.map((part) => part.start)).toEqual([0, 10]);
  });
  it("rejects a type outside the twelve-type contract", () => {
    expect(() => buildQualityResult([{ sourceStart: 0, sourceEnd: 2, points: [point("principle", 1)] }], "x")).toThrow();
  });
  it("does not claim a lesson for an empty result", () => {
    const result = buildQualityResult([{ sourceStart: 0, sourceEnd: 2, points: [] }], "x");
    expect(result.kps).toEqual([]);
    expect(result.lessons).toEqual([]);
  });
});
