import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  batchSections,
  extractKnowledgePoints,
  checkVerbatimEvidence,
  PrepExtractionError,
  type ExtractedKp,
} from "../src/prep/extractor.js";
import type { PrepSection } from "../src/prep/splitter.js";
import * as client from "../src/dialogue/client.js";

vi.mock("../src/dialogue/client.js", () => ({
  requestChatCompletion: vi.fn(),
}));

const mockRequest = vi.mocked(client.requestChatCompletion);

function section(index: number, title: string, content: string): PrepSection {
  return { index, title, content };
}

function kp(partial: Partial<ExtractedKp>): ExtractedKp {
  return {
    statement: "极限是微积分的基础概念",
    type: "concept",
    evidenceQuotes: ["极限是微积分的基础概念之一"],
    sectionIndex: 0,
    ...partial,
  };
}

const LLM_OK = JSON.stringify({
  knowledgePoints: [
    {
      statement: "极限是微积分的基础概念",
      type: "concept",
      evidenceQuotes: ["极限是微积分的基础概念之一"],
      sectionIndex: 0,
    },
  ],
});

beforeEach(() => {
  mockRequest.mockReset();
});

describe("batchSections", () => {
  it("merges consecutive sections under the char and count caps", () => {
    const sections = [
      section(0, "一", "a".repeat(900)),
      section(1, "二", "b".repeat(900)),
      section(2, "三", "c".repeat(300)),
      section(3, "四", "d".repeat(10)),
    ];
    const batches = batchSections(sections);
    // 900+900=1800 fits; adding 300 would exceed 2000 -> new batch; 300+10 fits.
    expect(batches).toHaveLength(2);
    expect(batches[0]!.sectionIndexes).toEqual([0, 1]);
    expect(batches[1]!.sectionIndexes).toEqual([2, 3]);
  });

  it("splits when the section count cap is reached", () => {
    const sections = Array.from({ length: 6 }, (_, i) =>
      section(i, `s${i}`, "x"),
    );
    const batches = batchSections(sections);
    expect(batches.map((b) => b.sectionIndexes)).toEqual([
      [0, 1, 2, 3, 4],
      [5],
    ]);
  });

  it("returns an empty list for empty sections", () => {
    expect(batchSections([])).toEqual([]);
  });
});

describe("checkVerbatimEvidence", () => {
  const sections = [section(0, "1.1 极限", "极限是微积分的基础概念之一。其他内容。")];

  it("passes for exact substrings", () => {
    const violations = checkVerbatimEvidence(
      [kp({ evidenceQuotes: ["极限是微积分的基础概念之一"] })],
      sections,
    );
    expect(violations).toEqual([]);
  });

  it("requires evidence to retain literal Markdown punctuation", () => {
    const source = "**组织（organization）**可以理解为共同目标的合作系统。\\n\\n- `2*3=6` 与 snake_case 都是原文。";
    expect(
      checkVerbatimEvidence(
        [
          kp({
            statement: "组织是为共同目标形成的合作系统",
            evidenceQuotes: ["**组织（organization）**可以理解为共同目标的合作系统。"],
          }),
          kp({
            statement: "算式与标识符必须保留符号",
            evidenceQuotes: ["`2*3=6` 与 snake_case 都是原文。"],
          }),
        ],
        [section(0, "1.1 组织", source)],
      ),
    ).toEqual([]);
  });

  it("rejects evidence that only matches after punctuation stripping", () => {
    const source = "公式是 2*3=6，变量名为 snake_case，示例是 `code`。";
    const violations = checkVerbatimEvidence(
      [
        kp({ evidenceQuotes: ["23=6"] }),
        kp({ evidenceQuotes: ["snakecase"] }),
      ],
      [section(0, "1.1 符号", source)],
    );
    expect(violations).toHaveLength(2);
  });

  it("flags a rewritten quote", () => {
    const violations = checkVerbatimEvidence(
      [kp({ evidenceQuotes: ["极限是微积分中最重要的概念"] })],
      sections,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("不是小节 0 原文的逐字片段");
  });

  it("flags an unknown section index", () => {
    const violations = checkVerbatimEvidence([kp({ sectionIndex: 9 })], sections);
    expect(violations[0]).toContain("不存在的小节 9");
  });
});

describe("extractKnowledgePoints", () => {
  const sections = [
    section(0, "1.1 极限", "极限是微积分的基础概念之一。其他内容。"),
  ];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns KP inputs on the first pass", async () => {
    mockRequest.mockResolvedValueOnce(LLM_OK);
    const result = await extractKnowledgePoints({
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      sections,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      statement: "极限是微积分的基础概念",
      type: "concept",
      sectionTitle: "1.1 极限",
      evidence: ["极限是微积分的基础概念之一"],
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("trims excess evidence quotes instead of failing an otherwise valid KP", async () => {
    mockRequest.mockResolvedValueOnce(
      JSON.stringify({
        knowledgePoints: [
          {
            statement: "极限是微积分的基础概念",
            type: "concept",
            evidenceQuotes: [
              "极限是微积分的基础概念之一",
              "其他内容",
              "极限是微积分的基础概念之一。其他内容。",
              "这条多余引文应被丢弃",
            ],
            sectionIndex: 0,
          },
        ],
      }),
    );
    const result = await extractKnowledgePoints({
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      sections,
    });
    expect(result[0]?.evidence).toEqual([
      "极限是微积分的基础概念之一",
      "其他内容",
      "极限是微积分的基础概念之一。其他内容。",
    ]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("retries with corrective feedback and succeeds", async () => {
    mockRequest
      .mockResolvedValueOnce(
        JSON.stringify({
          knowledgePoints: [
            {
              statement: "极限是微积分的基础概念",
              type: "concept",
              evidenceQuotes: ["被改写的引文"],
              sectionIndex: 0,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(LLM_OK);
    const result = await extractKnowledgePoints({
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      sections,
    });
    expect(result).toHaveLength(1);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    // The corrective retry names the violation.
    const secondCall = mockRequest.mock.calls[1]![0] as {
      messages: { role: string; content: string }[];
    };
    const corrective = secondCall.messages.at(-1)!.content;
    expect(corrective).toContain("逐字");
  });

  it("throws PrepExtractionError after a failed second attempt", async () => {
    mockRequest
      .mockResolvedValueOnce(
        JSON.stringify({
          knowledgePoints: [
            {
              statement: "s",
              type: "fact",
              evidenceQuotes: ["不存在的引文"],
              sectionIndex: 0,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          knowledgePoints: [
            {
              statement: "s",
              type: "fact",
              evidenceQuotes: ["仍然不存在的引文"],
              sectionIndex: 0,
            },
          ],
        }),
      );
    await expect(
      extractKnowledgePoints({
        baseUrl: "http://x",
        apiKey: "k",
        model: "m",
        sections,
      }),
    ).rejects.toThrow(PrepExtractionError);
  });

  it("wraps invalid JSON into PrepExtractionError after retry", async () => {
    mockRequest.mockResolvedValueOnce("not json at all").mockResolvedValueOnce("still not json");
    await expect(
      extractKnowledgePoints({
        baseUrl: "http://x",
        apiKey: "k",
        model: "m",
        sections,
      }),
    ).rejects.toThrow(PrepExtractionError);
  });
});
