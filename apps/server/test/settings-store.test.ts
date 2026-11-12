import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readSettings,
  writeSettings,
  maskApiKey,
} from "../src/settings/store.js";

describe("settings store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elenchi-settings-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no settings file exists", () => {
    expect(readSettings(tmpDir)).toBeNull();
  });

  it("round-trips settings through write and read", () => {
    writeSettings(tmpDir, {
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-123",
      model: "gpt-4o-mini",
    });
    const result = readSettings(tmpDir);
    expect(result).toEqual({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-123",
      model: "gpt-4o-mini",
    });
  });

  it("returns null when the settings file predates the model field", () => {
    fs.writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test-123",
      }),
    );
    expect(readSettings(tmpDir)).toBeNull();
  });

  it("returns null for a corrupted settings file", () => {
    fs.writeFileSync(path.join(tmpDir, "settings.json"), "{not json");
    expect(readSettings(tmpDir)).toBeNull();
  });
});

describe("maskApiKey", () => {
  it("masks a long key showing prefix and suffix", () => {
    expect(maskApiKey("sk-abcdefghijklmnop")).toBe("sk-...mnop");
  });

  it("fully masks a short key", () => {
    expect(maskApiKey("short")).toBe("*****");
  });
});
