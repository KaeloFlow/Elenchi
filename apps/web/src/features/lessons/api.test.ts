import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchLessonKps, fetchLessonQualitySummary } from "./api.js";

describe("fetchLessonKps", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the lesson KP list from the relative endpoint", async () => {
    const payload = {
      kps: [{ id: "kp1", statement: "消息传递建立因果约束", mastered: true }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("/api/lessons/l1/kps");
        return new Response(JSON.stringify(payload), { status: 200 });
      }),
    );
    await expect(fetchLessonKps("l1")).resolves.toEqual(payload);
  });

  it("fetches the published evidence summary", async () => {
    const payload = { lessonId: "l1", cardVersion: "v1", taskCount: 2, requirementCount: 3, independentRequirementCount: 2 };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { expect(url).toBe("/api/lessons/l1/quality-summary"); return new Response(JSON.stringify(payload), { status: 200 }); }));
    await expect(fetchLessonQualitySummary("l1")).resolves.toEqual(payload);
  });

  it("throws on non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    await expect(fetchLessonKps("missing")).rejects.toThrow("HTTP 404");
  });
});
