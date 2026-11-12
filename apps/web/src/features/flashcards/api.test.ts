import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generateFlashcards,
  fetchFlashcards,
  updateFlashcard,
  deleteFlashcard,
} from "./api.js";

describe("flashcards api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generateFlashcards posts to the generate endpoint and returns the cards", () => {
    const body = { flashcards: [{ id: "f1", sessionId: "s1", question: "q", options: null, answer: "a", explanation: null, createdAt: 1 }] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    return generateFlashcards("s1").then((result) => {
      expect(result).toEqual(body);
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/flashcards/generate", {
        method: "POST",
      });
    });
  });

  it("generateFlashcards throws the backend error detail on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ error: "extraction_failed", details: "LLM 未返回合法的 JSON" }),
      }),
    );

    await expect(generateFlashcards("s1")).rejects.toThrow("LLM 未返回合法的 JSON");
  });

  it("fetchFlashcards returns the parsed list", async () => {
    const body = [{ id: "f1", sessionId: "s1", question: "q", options: null, answer: "a", explanation: null, createdAt: 1 }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchFlashcards("s1");

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/flashcards");
  });

  it("updateFlashcard PUTs the partial update and returns the updated card", async () => {
    const body = { id: "f1", sessionId: "s1", question: "q", options: null, answer: "a2", explanation: null, createdAt: 1 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateFlashcard("f1", { answer: "a2" });

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/flashcards/f1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "a2" }),
    });
  });

  it("deleteFlashcard succeeds on a 204 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }));

    await expect(deleteFlashcard("f1")).resolves.toBeUndefined();
  });

  it("deleteFlashcard throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(deleteFlashcard("f1")).rejects.toThrow("HTTP 404");
  });
});
