import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { requestChatCompletion, streamChatCompletion } from "../src/dialogue/client.js";

function startFakeSseServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      // WHATWG fetch rejects a small set of reserved ports before opening a
      // socket. Retry allocation if the OS happens to choose one.
      const badPorts = new Set([5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 10080]);
      if (badPorts.has(port)) {
        server.close(() => {
          startFakeSseServer(handler).then(resolve);
        });
        return;
      }
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("streamChatCompletion", () => {
  let fakeServer: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await fakeServer?.close();
    fakeServer = undefined;
  });

  it("yields text deltas parsed from SSE data lines and stops at [DONE]", async () => {
    fakeServer = await startFakeSseServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "先" } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "别急" } }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const deltas: string[] = [];
    for await (const delta of streamChatCompletion({
      baseUrl: fakeServer.url,
      apiKey: "sk-test",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    })) {
      deltas.push(delta);
    }

    expect(deltas.join("")).toBe("先别急");
  });

  it("skips delta-less events (e.g. role-only chunks) without yielding empty strings", async () => {
    fakeServer = await startFakeSseServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const deltas: string[] = [];
    for await (const delta of streamChatCompletion({
      baseUrl: fakeServer.url,
      apiKey: "sk-test",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(["好"]);
  });

  it("throws when the endpoint returns a non-2xx status", async () => {
    fakeServer = await startFakeSseServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });

    const iterate = async () => {
      for await (const _ of streamChatCompletion({
        baseUrl: fakeServer!.url,
        apiKey: "sk-bad",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      })) {
        // no-op
      }
    };

    await expect(iterate()).rejects.toThrow(/HTTP 401/);
  });

  it("sends the model, messages, and stream:true in the request body", async () => {
    let receivedBody: unknown;
    fakeServer = await startFakeSseServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "hi" },
    ];
    for await (const _ of streamChatCompletion({
      baseUrl: fakeServer.url,
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      messages,
    })) {
      // no-op
    }

    expect(receivedBody).toEqual({
      model: "gpt-4o-mini",
      messages,
      stream: true,
    });
  });
});

describe("LLM transport transient retry", () => {
  let fakeServer: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await fakeServer?.close();
    fakeServer = undefined;
  });

  it("requestChatCompletion retries a connection reset and succeeds", async () => {
    let requests = 0;
    fakeServer = await startFakeSseServer((req, res) => {
      requests++;
      if (requests === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "好" } }] }));
    });

    const content = await requestChatCompletion({
      baseUrl: fakeServer.url,
      apiKey: "sk-test",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(content).toBe("好");
    expect(requests).toBe(2);
  });

  it("requestChatCompletion exhausts retries and reports the connection cause", async () => {
    let requests = 0;
    fakeServer = await startFakeSseServer((req, _res) => {
      requests++;
      req.socket.destroy();
    });

    await expect(
      requestChatCompletion({
        baseUrl: fakeServer.url,
        apiKey: "sk-test",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/LLM 连接失败/);
    expect(requests).toBe(3);
  }, 15000);

  it("streamChatCompletion retries a connection reset before any delta", async () => {
    let requests = 0;
    fakeServer = await startFakeSseServer((req, res) => {
      requests++;
      if (requests === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const deltas: string[] = [];
    for await (const delta of streamChatCompletion({
      baseUrl: fakeServer.url,
      apiKey: "sk-test",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    })) {
      deltas.push(delta);
    }

    expect(deltas.join("")).toBe("好");
    expect(requests).toBe(2);
  });

  it("does not retry an already-aborted request or wrap it as a connection failure", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(requestChatCompletion({ baseUrl: "http://127.0.0.1:1", apiKey: "sk-test", model: "test-model", messages: [{ role: "user", content: "hi" }], signal: controller.signal })).rejects.toThrow();
  });

  it("does not retry HTTP error statuses", async () => {
    let requests = 0;
    fakeServer = await startFakeSseServer((req, res) => {
      requests++;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });

    await expect(
      requestChatCompletion({
        baseUrl: fakeServer.url,
        apiKey: "sk-bad",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/HTTP 401/);
    expect(requests).toBe(1);
  });
});
