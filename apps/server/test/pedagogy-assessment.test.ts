import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import {
  assessAnswer,
  PedagogyAssessmentError,
} from "../src/pedagogy/assessment.js";

const LESSON_KPS = [
  { id: "kp-1", statement: "0.999... 等于 1", type: "principle" },
  { id: "kp-2", statement: "极限的直观定义", type: "concept" },
];

const CONTEXT = {
  lessonKps: LESSON_KPS,
  targetKp: LESSON_KPS[0]!,
  focusSectionContent: "极限是微积分的基础概念。0.999... 等于 1。",
  recentMessages: [],
  userAnswer: "0.999... 不可能等于 1 吧",
};

const VALID_ASSESSMENT_JSON = JSON.stringify({
  correctness: "incorrect",
  completeness: "missing_reasoning",
  reasoningQuality: "none",
  misconceptions: ["把无限小数理解为永远接近但不能等于"],
  userSignals: [],
  evidenceQuotes: ["0.999... 等于 1。"],
  coveredKpIds: [],
  focus: "0.999... 与 1 的关系",
});

function startFakeJsonLlm(
  payloads: string[],
): Promise<{
  url: string;
  close: () => Promise<void>;
  callCount: () => number;
  lastBody: () => unknown;
}> {
  let calls = 0;
  let lastRequestBody: unknown = null;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          lastRequestBody = JSON.parse(body);
        } catch {
          lastRequestBody = null;
        }
        const payload = payloads[Math.min(calls, payloads.length - 1)]!;
        calls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ choices: [{ message: { content: payload } }] }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        callCount: () => calls,
        lastBody: () => lastRequestBody,
      });
    });
  });
}

describe("assessAnswer", () => {
  let fake: Awaited<ReturnType<typeof startFakeJsonLlm>> | undefined;

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  function options(baseUrl: string) {
    return {
      baseUrl,
      apiKey: "sk-test",
      model: "test-model",
      context: CONTEXT,
    };
  }

  it("parses a valid assessment payload", async () => {
    fake = await startFakeJsonLlm([VALID_ASSESSMENT_JSON]);
    const result = await assessAnswer(options(fake.url));
    expect(result.correctness).toBe("incorrect");
    expect(result.misconceptions).toEqual([
      "把无限小数理解为永远接近但不能等于",
    ]);
    expect(fake.callCount()).toBe(1);
  });

  it("fills defaults when the model omits optional arrays", async () => {
    fake = await startFakeJsonLlm([
      JSON.stringify({
        correctness: "correct",
        completeness: "complete",
        reasoningQuality: "sound",
      }),
    ]);
    const result = await assessAnswer(options(fake.url));
    expect(result.misconceptions).toEqual([]);
    expect(result.coveredKpIds).toEqual([]);
    expect(result.focus).toBeNull();
  });

  it("strips a markdown code fence around the JSON", async () => {
    fake = await startFakeJsonLlm([
      "```json\n" + VALID_ASSESSMENT_JSON + "\n```",
    ]);
    const result = await assessAnswer(options(fake.url));
    expect(result.correctness).toBe("incorrect");
  });

  it("retries once with corrective feedback on invalid JSON, then succeeds", async () => {
    fake = await startFakeJsonLlm(["这不是 JSON", VALID_ASSESSMENT_JSON]);
    const result = await assessAnswer(options(fake.url));
    expect(result.correctness).toBe("incorrect");
    expect(fake.callCount()).toBe(2);
  });

  it("throws PedagogyAssessmentError when both attempts are invalid", async () => {
    fake = await startFakeJsonLlm(["不是 JSON", "还是不是 JSON"]);
    await expect(assessAnswer(options(fake.url))).rejects.toBeInstanceOf(
      PedagogyAssessmentError,
    );
    expect(fake.callCount()).toBe(2);
  });

  it("throws when the payload violates the schema twice", async () => {
    fake = await startFakeJsonLlm([
      JSON.stringify({ correctness: "right" }),
      JSON.stringify({ correctness: "right" }),
    ]);
    await expect(assessAnswer(options(fake.url))).rejects.toBeInstanceOf(
      PedagogyAssessmentError,
    );
  });

  it("rejects coveredKpIds outside the lesson's closed set via retry", async () => {
    const rogue = JSON.stringify({
      correctness: "correct",
      completeness: "complete",
      reasoningQuality: "sound",
      coveredKpIds: ["rogue-id"],
    });
    fake = await startFakeJsonLlm([rogue, VALID_ASSESSMENT_JSON]);
    const result = await assessAnswer(options(fake.url));
    expect(result.coveredKpIds).toEqual([]);
    expect(fake.callCount()).toBe(2);
    const retryBody = (fake.lastBody() as {
      messages: { content: string }[];
    }).messages.at(-1)!.content;
    expect(retryBody).toContain("rogue-id");
  });

  it("fails explicitly when the closed-set violation persists", async () => {
    const rogue = JSON.stringify({
      correctness: "correct",
      completeness: "complete",
      reasoningQuality: "sound",
      coveredKpIds: ["rogue-id"],
    });
    fake = await startFakeJsonLlm([rogue, rogue]);
    await expect(assessAnswer(options(fake.url))).rejects.toThrow(
      "本课之外",
    );
  });

  it("sends the lesson KP list, section content and user answer to the LLM", async () => {
    fake = await startFakeJsonLlm([VALID_ASSESSMENT_JSON]);
    await assessAnswer(options(fake.url));
    const body = fake.lastBody() as {
      messages: { content: string }[];
    };
    const userContent = body.messages.at(-1)!.content;
    expect(userContent).toContain("[kp-1]");
    expect(userContent).toContain("0.999... 等于 1。");
    expect(userContent).toContain("0.999... 不可能等于 1 吧");
  });
});
