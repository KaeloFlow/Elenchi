import { describe, it, expect, vi, beforeEach } from "vitest";
import { auditCoverage } from "../src/prep/auditor.js";
import type { PrepSection } from "../src/prep/splitter.js";
import type { KpInput } from "../src/prep/store.js";
import * as client from "../src/dialogue/client.js";

vi.mock("../src/dialogue/client.js", () => ({
  requestChatCompletion: vi.fn(),
}));

const mockRequest = vi.mocked(client.requestChatCompletion);

const section: PrepSection = {
  index: 0,
  title: "1.1 极限",
  content: "极限是微积分的基础概念。极限描述趋近过程。此外还有夹逼准则。",
};

const kp: KpInput = {
  statement: "极限是微积分的基础概念",
  type: "concept",
  sectionIndex: 0,
  sectionTitle: "1.1 极限",
  evidence: ["极限是微积分的基础概念"],
};

function auditJson(quotes: string[]): string {
  return JSON.stringify({ uncoveredQuotes: quotes });
}

beforeEach(() => {
  mockRequest.mockReset();
});

function baseOptions(overrides?: {
  reextractSection?: (section: PrepSection, gaps: string[]) => Promise<KpInput[]>;
}) {
  return {
    baseUrl: "http://x",
    apiKey: "k",
    model: "m",
    sections: [section],
    kps: [kp],
    reextractSection:
      overrides?.reextractSection ??
      vi.fn(async (): Promise<KpInput[]> => []),
  };
}

describe("auditCoverage", () => {
  it("passes with no partial sections when fully covered", async () => {
    mockRequest.mockResolvedValueOnce(auditJson([]));
    const options = baseOptions();
    const result = await auditCoverage(options);
    expect(result.kps).toHaveLength(1);
    expect(result.partialSections).toBe(0);
    expect(options.reextractSection).not.toHaveBeenCalled();
  });

  it("re-extracts once when gaps exist and the re-audit then passes", async () => {
    mockRequest
      .mockResolvedValueOnce(auditJson(["此外还有夹逼准则"]))
      .mockResolvedValueOnce(auditJson([]));
    const reextractSection = vi.fn(async (): Promise<KpInput[]> => [
      {
        statement: "夹逼准则",
        type: "principle",
        sectionIndex: 0,
        sectionTitle: "1.1 极限",
        evidence: ["此外还有夹逼准则"],
      },
    ]);
    const result = await auditCoverage(baseOptions({ reextractSection }));
    expect(result.partialSections).toBe(0);
    expect(result.kps).toHaveLength(2);
    expect(reextractSection).toHaveBeenCalledTimes(1);
    expect(reextractSection.mock.calls[0]![1]).toEqual(["此外还有夹逼准则"]);
  });

  it("counts a section as partial when gaps survive the retry", async () => {
    mockRequest
      .mockResolvedValueOnce(auditJson(["此外还有夹逼准则"]))
      .mockResolvedValueOnce(auditJson(["此外还有夹逼准则"]));
    const result = await auditCoverage(baseOptions());
    expect(result.partialSections).toBe(1);
    expect(result.kps).toHaveLength(1);
  });

  it("counts a section as partial when the audit call itself fails", async () => {
    mockRequest.mockResolvedValueOnce("not json");
    const result = await auditCoverage(baseOptions());
    expect(result.partialSections).toBe(1);
    expect(result.kps).toHaveLength(1);
  });

  it.each([
    ["原文中根本不存在的一句话"],
    ["此外还有夹逼准则", "原文中根本不存在的一句话"],
  ])("counts invalid audit quotes as partial: %j", async (...quotes) => {
    mockRequest.mockResolvedValueOnce(auditJson(quotes));
    const options = baseOptions();
    const result = await auditCoverage(options);
    expect(result.partialSections).toBe(1);
    expect(result.kps).toEqual([kp]);
    expect(options.reextractSection).not.toHaveBeenCalled();
  });
});
