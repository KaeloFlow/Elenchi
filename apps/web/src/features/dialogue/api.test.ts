import { describe, it, expect, vi, afterEach } from "vitest";
import { createSession, fetchEvidenceProgress, fetchMessages, fetchSessionMisconceptions, sendMessage } from "./api.js";

function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

describe("dialogue api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchEvidenceProgress parses the current card-bound counts", async () => {
    const body = { sessionId: "s1", cardVersion: "v1", totalRequirementCount: 3, satisfiedRequirementCount: 1, uncertainRequirementCount: 1, notSatisfiedRequirementCount: 1 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body }); vi.stubGlobal("fetch", fetchMock);
    await expect(fetchEvidenceProgress("s1")).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/evidence-progress");
  });

  it("fetchEvidenceProgress surfaces HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchEvidenceProgress("missing")).rejects.toThrow("HTTP 404");
  });

  it("fetchSessionMisconceptions parses structured statuses", async () => {
    const body = { sessionId: "s1", records: [{ label: "混淆条件", kpId: "kp1", status: "uncertain" }] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body }); vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSessionMisconceptions("s1")).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/misconceptions");
  });

  it("fetchSessionMisconceptions surfaces HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchSessionMisconceptions("missing")).rejects.toThrow("HTTP 404");
  });

  it("createSession posts the lessonId and returns the session", async () => {
    const body = {
      id: "s1",
      materialId: "m1",
      chunkId: "c1",
      lessonId: "l1",
      startedAt: 1,
      openingMessage: {
        id: "msg0",
        sessionId: "s1",
        role: "assistant",
        content: "开场",
        createdAt: 1,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createSession("l1");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId: "l1" }),
    });
  });

  it("createSession surfaces reuse (no openingMessage) unchanged", async () => {
    const body = {
      id: "s1",
      materialId: "m1",
      chunkId: "c1",
      lessonId: "l1",
      startedAt: 1,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => body }),
    );

    const result = await createSession("l1");
    expect(result).toEqual(body);
    expect(result.openingMessage).toBeUndefined();
  });

  it("createSession throws the backend error detail on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: "lesson_not_found", details: "课程不存在: x" }),
      }),
    );

    await expect(createSession("x")).rejects.toThrow("课程不存在: x");
  });

  it("fetchMessages returns the parsed message list", async () => {
    const body = [
      { id: "msg1", sessionId: "s1", role: "user", content: "hi", createdAt: 1 },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMessages("s1");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/messages");
  });

  it("sendMessage invokes onDelta for each delta and onDone at the end", async () => {
    const stream = makeSseStream([
      `data: ${JSON.stringify({ delta: "先" })}\n\n`,
      `data: ${JSON.stringify({ delta: "别急" })}\n\n`,
      `data: ${JSON.stringify({ done: true, messageId: "msg2", userMessageId: "msg1", createdAt: 42 })}\n\n`,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, body: stream }),
    );

    const deltas: string[] = [];
    let doneArgs: [string, string, number] | undefined;
    await sendMessage("s1", "0.999... 不可能等于 1 吧", {
      onDelta: (d) => deltas.push(d),
      onDone: (userMessageId, assistantMessageId, createdAt) =>
        (doneArgs = [userMessageId, assistantMessageId, createdAt]),
      onError: () => {
        throw new Error("should not be called");
      },
    });

    expect(deltas.join("")).toBe("先别急");
    expect(doneArgs).toEqual(["msg1", "msg2", 42]);
  });

  it("sendMessage processes a terminal event once and ignores later frames", async () => {
    const stream = makeSseStream([
      `data: ${JSON.stringify({ done: true, messageId: "msg2", userMessageId: "msg1", createdAt: 42 })}\n\n`,
      `data: ${JSON.stringify({ error: "must be ignored" })}\n\n`,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, body: stream }),
    );

    const calls: string[] = [];
    await sendMessage("s1", "hi", {
      onDelta: () => calls.push("delta"),
      onDone: () => calls.push("done"),
      onError: () => calls.push("error"),
    });

    expect(calls).toEqual(["done"]);
  });

  it("sendMessage accepts a terminal frame at EOF without a trailing delimiter", async () => {
    const stream = makeSseStream([
      `data: ${JSON.stringify({ done: true, messageId: "msg2", userMessageId: "msg1", createdAt: 42 })}`,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, body: stream }),
    );

    const calls: string[] = [];
    await sendMessage("s1", "hi", {
      onDelta: () => calls.push("delta"),
      onDone: () => calls.push("done"),
      onError: () => calls.push("error"),
    });

    expect(calls).toEqual(["done"]);
  });

  it("sendMessage reports an interrupted stream that ends without done or error", async () => {
    const stream = makeSseStream([
      `data: ${JSON.stringify({ delta: "半条回复" })}\n\n`,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, body: stream }),
    );

    let received: string | undefined;
    await sendMessage("s1", "hi", {
      onDelta: () => {},
      onDone: () => {
        throw new Error("should not be called");
      },
      onError: (message) => (received = message),
    });

    expect(received).toBe("连接意外中断，请重试");
  });

  it("sendMessage invokes onError when the server sends an error event", async () => {
    const stream = makeSseStream([
      `data: ${JSON.stringify({ error: "LLM 请求失败" })}\n\n`,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, body: stream }),
    );

    let received: string | undefined;
    await sendMessage("s1", "hi", {
      onDelta: () => {
        throw new Error("should not be called");
      },
      onDone: () => {
        throw new Error("should not be called");
      },
      onError: (message) => (received = message),
    });

    expect(received).toBe("LLM 请求失败");
  });

  it("sendMessage invokes onError with the backend detail on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "llm_not_configured" }),
      }),
    );

    let received: string | undefined;
    await sendMessage("s1", "hi", {
      onDelta: () => {},
      onDone: () => {},
      onError: (message) => (received = message),
    });

    expect(received).toBe("llm_not_configured");
  });

  it("sendMessage invokes onError when fetch itself rejects (network failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch failed")),
    );

    let received: string | undefined;
    await sendMessage("s1", "hi", {
      onDelta: () => {
        throw new Error("should not be called");
      },
      onDone: () => {
        throw new Error("should not be called");
      },
      onError: (message) => (received = message),
    });

    expect(received).toBe("fetch failed");
  });
});
