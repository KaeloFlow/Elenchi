import type {
  UpdateLlmSettingsInput,
  LlmSettingsResponse,
  TestConnectionInput,
  TestConnectionResult,
} from "@elenchi/shared";

export async function fetchSettings(): Promise<LlmSettingsResponse> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveSettings(
  input: UpdateLlmSettingsInput,
): Promise<LlmSettingsResponse> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function testConnection(
  input: TestConnectionInput,
): Promise<TestConnectionResult> {
  const res = await fetch("/api/settings/test-connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
