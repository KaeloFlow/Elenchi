import fs from "node:fs";
import path from "node:path";

/**
 * Sole owner of settings.json read/write. No other module may touch this
 * file directly (see design spec constraint 6: single config module,
 * upgradeable to encrypted storage later).
 */
export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const SETTINGS_FILE = "settings.json";

export function readSettings(dataDir: string): LlmSettings | null {
  const filePath = path.join(dataDir, SETTINGS_FILE);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    const parsed = JSON.parse(raw) as Partial<LlmSettings>;
    if (!parsed.baseUrl || !parsed.apiKey || !parsed.model) return null;
    return {
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      model: parsed.model,
    };
  } catch {
    return null;
  }
}

export function writeSettings(dataDir: string, settings: LlmSettings): void {
  const filePath = path.join(dataDir, SETTINGS_FILE);
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Shows first 3 and last 4 characters; fully masks keys of 6 chars or fewer. */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 6) return "*".repeat(apiKey.length);
  return `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`;
}
