import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { startServer, type StartedServer } from "../src/server.js";

function startFakeLlmServer(
  status: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [] }));
    });
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

describe("settings routes", () => {
  let server: StartedServer | undefined;
  let tmpDir: string;

  afterEach(async () => {
    await server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports not configured before any settings are saved", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-settings-route-"));
    server = await startServer({ dataDir: tmpDir, port: 0 });

    const res = await fetch(`${server.url}/api/settings`);
    const body = await res.json();

    expect(body.configured).toBe(false);
    expect(body.apiKeyPreview).toBeNull();
  });

  it("saves settings and masks the api key on read-back", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-settings-route-"));
    server = await startServer({ dataDir: tmpDir, port: 0 });

    const putRes = await fetch(`${server.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-abcdefgh",
        model: "gpt-4o-mini",
      }),
    });
    const putBody = await putRes.json();

    expect(putRes.status).toBe(200);
    expect(putBody.configured).toBe(true);
    expect(putBody.apiKeyPreview).toBe("sk-...efgh");
    expect(putBody.baseUrl).toBe("https://api.example.com/v1");
    expect(putBody.model).toBe("gpt-4o-mini");
  });

  it("updates baseUrl and model while keeping the stored apiKey when apiKey is omitted", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-settings-route-"));
    server = await startServer({ dataDir: tmpDir, port: 0 });

    await fetch(`${server.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-abcdefgh",
        model: "gpt-4o-mini",
      }),
    });

    const putRes = await fetch(`${server.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://api.new.example.com/v1",
        model: "gpt-4o",
      }),
    });
    const putBody = await putRes.json();

    expect(putRes.status).toBe(200);
    expect(putBody.configured).toBe(true);
    expect(putBody.baseUrl).toBe("https://api.new.example.com/v1");
    expect(putBody.model).toBe("gpt-4o");
    expect(putBody.apiKeyPreview).toBe("sk-...efgh");
  });

  it("rejects an apiKey-less update with 400 api_key_required before first configuration", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-settings-route-"));
    server = await startServer({ dataDir: tmpDir, port: 0 });

    const res = await fetch(`${server.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("api_key_required");
  });

  it("rejects an invalid settings payload with 400", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-settings-route-"));
    server = await startServer({ dataDir: tmpDir, port: 0 });

    const res = await fetch(`${server.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "not-a-url", apiKey: "", model: "" }),
    });

    expect(res.status).toBe(400);
  });

  it("reports a successful test-connection result", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-settings-route-"));
    server = await startServer({ dataDir: tmpDir, port: 0 });
    const fakeLlm = await startFakeLlmServer(200);

    const res = await fetch(`${server.url}/api/settings/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: fakeLlm.url, apiKey: "sk-test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    await fakeLlm.close();
  });

  it("reports a failed test-connection result on non-2xx response", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-settings-route-"));
    server = await startServer({ dataDir: tmpDir, port: 0 });
    const fakeLlm = await startFakeLlmServer(401);

    const res = await fetch(`${server.url}/api/settings/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: fakeLlm.url, apiKey: "sk-bad" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);

    await fakeLlm.close();
  });
});
