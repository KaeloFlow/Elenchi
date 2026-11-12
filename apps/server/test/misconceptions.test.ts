import { describe, expect, it } from "vitest";
import { evolveMisconceptions } from "../src/pedagogy/misconceptions.js";
describe("misconception lifecycle", () => {
  it("records new diagnoses as active and reactivates repeated diagnoses", () => {
    const first = evolveMisconceptions({ current: [], diagnosed: ["混淆条件"], targetKpId: "k", evidenceSatisfiedKpIds: [], evidenceMessageId: "m1" });
    expect(first).toEqual([{ label: "混淆条件", kpId: "k", status: "active", evidenceMessageIds: ["m1"] }]);
    expect(evolveMisconceptions({ current: [{ ...first[0]!, status: "uncertain" }], diagnosed: ["混淆条件"], targetKpId: "k", evidenceSatisfiedKpIds: [], evidenceMessageId: "m2" })[0]?.status).toBe("active");
  });
  it("requires two later same-KP independent evidences to resolve", () => {
    const active = [{ label: "混淆条件", kpId: "k", status: "active" as const, evidenceMessageIds: ["m1"] }];
    const uncertain = evolveMisconceptions({ current: active, diagnosed: [], targetKpId: "k", evidenceSatisfiedKpIds: ["k"], evidenceMessageId: "m2" });
    expect(uncertain[0]?.status).toBe("uncertain");
    const resolved = evolveMisconceptions({ current: uncertain, diagnosed: [], targetKpId: "k", evidenceSatisfiedKpIds: ["k"], evidenceMessageId: "m3" });
    expect(resolved[0]).toMatchObject({ status: "resolved", evidenceMessageIds: ["m1", "m2", "m3"] });
  });

  it("downgrades only same-KP independent evidence to uncertain", () => {
    const active = [{ label: "混淆条件", kpId: "k", status: "active" as const, evidenceMessageIds: ["m1"] }];
    expect(evolveMisconceptions({ current: active, diagnosed: [], targetKpId: "other", evidenceSatisfiedKpIds: ["other"], evidenceMessageId: "m2" })[0]?.status).toBe("active");
    expect(evolveMisconceptions({ current: active, diagnosed: [], targetKpId: "k", evidenceSatisfiedKpIds: ["k"], evidenceMessageId: "m2" })[0]?.status).toBe("uncertain");
  });
});
