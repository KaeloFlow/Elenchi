import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSettings, saveSettings, testConnection } from "./api.js";

describe("settings api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchSettings returns the parsed JSON body on success", async () => {
    const body = {
      configured: false,
      baseUrl: null,
      apiKeyPreview: null,
      model: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => body,
      }),
    );

    const result = await fetchSettings();

    expect(result).toEqual(body);
    expect(fetch).toHaveBeenCalledWith("/api/settings");
  });

  it("fetchSettings throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    await expect(fetchSettings()).rejects.toThrow("HTTP 500");
  });

  it("saveSettings PUTs JSON and returns the response body", async () => {
    const input = {
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-1",
      model: "gpt-4o-mini",
    };
    const body = {
      configured: true,
      baseUrl: input.baseUrl,
      apiKeyPreview: "sk-***1",
      model: input.model,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveSettings(input);

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  });

  it("testConnection POSTs JSON and returns the response body", async () => {
    const input = { baseUrl: "https://api.example.com/v1", apiKey: "sk-1" };
    const body = { ok: true, message: "connected" };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await testConnection(input);

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  });
});
