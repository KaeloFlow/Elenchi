import { describe, it, expect, afterEach } from "vitest";
import { startServer, type StartedServer } from "../src/server.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("server health check", () => {
  let server: StartedServer | undefined;
  let tmpDir: string;

  afterEach(async () => {
    await server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("responds ok on /api/health with injected data dir", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-test-"));
    server = await startServer({ dataDir: tmpDir, port: 0 });

    const res = await fetch(`${server.url}/api/health`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.dataDir).toBe(tmpDir);
    expect(server.port).toBeGreaterThan(0);
  });
});
