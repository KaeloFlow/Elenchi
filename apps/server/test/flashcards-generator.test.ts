import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { extractFlashcards } from "../src/flashcards/generator.js";

function startFakeLlmServer(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(respond);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function jsonCompletionResponder(content: string) {
  return (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    );
  };
}

describe("extractFlashcards", () => {
  let fakeServer: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await fakeServer?.close();
    fakeServer = undefined;
  });

  const context = {
    materialTitle: "微积分入门",
    chunkTitle: "第一章 极限",
    history: [
      { role: "user" as const, content: "0.999... 不可能等于 1 吧" },
      { role: "assistant" as const, content: "先别急。⅓ × 3 等于多少？" },
      { role: "user" as const, content: "1……等等，0.999... 就是 1？！" },
    ],
  };

  it("parses a valid extraction response into flashcards", async () => {
    const payload = JSON.stringify({
      flashcards: [
        {
          question: "0.999... 等于多少？",
          options: ["0.999...", "1", "无法确定"],
          answer: "1",
          explanation: "⅓ × 3 = 1，而 ⅓ = 0.333...",
        },
      ],
    });
    fakeServer = await startFakeLlmServer(jsonCompletionResponder(payload));

    const cards = await extractFlashcards({
      baseUrl: fakeServer.url,
      apiKey: "sk-test",
      model: "test-model",
      context,
    });

    expect(cards).toHaveLength(1);
    expect(cards[0].answer).toBe("1");
  });

  it("strips a markdown code fence around the JSON before parsing", async () => {
    const payload = "```json\n" + JSON.stringify({ flashcards: [] }) + "\n```";
    fakeServer = await startFakeLlmServer(jsonCompletionResponder(payload));

    const cards = await extractFlashcards({
      baseUrl: fakeServer.url,
      apiKey: "sk-test",
      model: "test-model",
      context,
    });

    expect(cards).toEqual([]);
  });

  it("throws when the LLM response is not valid JSON", async () => {
    fakeServer = await startFakeLlmServer(
      jsonCompletionResponder("这不是 JSON，抱歉"),
    );

    await expect(
      extractFlashcards({
        baseUrl: fakeServer.url,
        apiKey: "sk-test",
        model: "test-model",
        context,
      }),
    ).rejects.toThrow(/未返回合法的 JSON/);
  });

  it("throws when the JSON does not match the expected shape", async () => {
    const payload = JSON.stringify({ notFlashcards: [] });
    fakeServer = await startFakeLlmServer(jsonCompletionResponder(payload));

    await expect(
      extractFlashcards({
        baseUrl: fakeServer.url,
        apiKey: "sk-test",
        model: "test-model",
        context,
      }),
    ).rejects.toThrow(/不符合预期格式/);
  });

  it("sends stream:false and includes the transcript in the user message", async () => {
    let receivedBody: any;
    fakeServer = await startFakeLlmServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ flashcards: [] }) } },
            ],
          }),
        );
      });
    });

    await extractFlashcards({
      baseUrl: fakeServer.url,
      apiKey: "sk-test",
      model: "test-model",
      context,
    });

    expect(receivedBody.stream).toBe(false);
    expect(receivedBody.model).toBe("test-model");
    const userMessage = receivedBody.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMessage.content).toContain("0.999... 不可能等于 1 吧");
    expect(userMessage.content).toContain("微积分入门");
  });
});
