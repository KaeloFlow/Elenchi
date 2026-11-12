export interface TestConnectionOutcome {
  ok: boolean;
  message: string;
}

/**
 * Verifies OpenAI-protocol-compatible credentials by calling {baseUrl}/models.
 * Never persists anything; pure verification.
 */
export async function testLlmConnection(
  baseUrl: string,
  apiKey: string,
): Promise<TestConnectionOutcome> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, message: `HTTP ${res.status}: ${res.statusText}` };
    }
    return { ok: true, message: "连接成功" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `连接失败: ${message}` };
  } finally {
    clearTimeout(timeout);
  }
}
