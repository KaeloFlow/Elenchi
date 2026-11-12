export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

/**
 * Transient-failure policy for the LLM transport (owner of all LLM HTTP
 * calls — extractor, auditor, scheduler, flashcards, dialogue all route
 * through here). A long prep run issues dozens of sequential requests, so a
 * single network hiccup (CDN reset, brief drop) previously failed the whole
 * chapter with an opaque "fetch failed". Before response headers arrive,
 * retrying is safe: the request carries no local side effects.
 *
 * Retries ONLY pre-response network failures (undici's TypeError "fetch
 * failed": DNS, TCP, TLS, connection reset). Aborts are never retried, and
 * HTTP error statuses are returned as-is (they carry the server's own
 * message and are not transient).
 */
const TRANSIENT_RETRY_MAX_ATTEMPTS = 3;
const TRANSIENT_RETRY_BASE_DELAY_MS = 500;
const TRANSIENT_RETRY_JITTER_MS = 250;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function isTransientNetworkError(err: unknown): boolean {
  // fetch() rejects with TypeError "fetch failed" for pre-response network
  // failures; the specific reason (ECONNRESET, ENOTFOUND, ...) is on `cause`.
  // "terminated" is undici's term for a dropped connection mid-exchange
  // (server idle/read timeout on slow LLM responses) — also transient.
  return (
    err instanceof TypeError &&
    (err.message === "fetch failed" || err.message === "terminated")
  );
}

function describeCause(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return [code, err.message].filter(Boolean).join(" ");
  }
  return String(err);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * fetch with bounded retry for transient pre-response network errors.
 * Exponential backoff (500ms, 1s, + jitter); honors the caller's signal
 * between attempts. Never retries once response headers are received.
 */
async function fetchLlm(url: string, init: RequestInit, beforeAttempt?: () => void): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_RETRY_MAX_ATTEMPTS; attempt++) {
    init.signal?.throwIfAborted();
    // Reservation errors are not network failures and must never be retried.
    beforeAttempt?.();
    try {
      return await fetch(url, init);
    } catch (err) {
      if (
        init.signal?.aborted ||
        isAbortError(err) ||
        !isTransientNetworkError(err)
      ) {
        throw err;
      }
      lastErr = err;
      if (attempt < TRANSIENT_RETRY_MAX_ATTEMPTS) {
        await delay(
          TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) +
            Math.random() * TRANSIENT_RETRY_JITTER_MS,
          init.signal ?? undefined,
        );
      }
    }
  }
  throw lastErr;
}

/**
 * Wraps a pre-response network failure into an actionable message instead of
 * the bare undici "fetch failed", preserving the original error as `cause`.
 */
function connectionError(err: unknown, url: string): Error {
  const host = new URL(url).host;
  return new Error(
    `LLM 连接失败: ${describeCause(err instanceof Error ? err.cause : err)} (${host})`,
    { cause: err },
  );
}

/**
 * Streams a chat completion from an OpenAI-protocol-compatible endpoint and
 * yields text deltas as they arrive. Parses the standard SSE framing used by
 * `/chat/completions` with `stream: true`: lines prefixed `data: `, a
 * terminating `data: [DONE]`, one JSON object per event with
 * `choices[0].delta.content`.
 *
 * Pure transport concern — does not persist anything and does not know about
 * sessions/messages (see dialogue/store.ts for persistence).
 */
export async function* streamChatCompletion(
  options: StreamChatOptions,
): AsyncGenerator<string, void, undefined> {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let res: Response;
  try {
    res = await fetchLlm(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: true,
      }),
      signal: options.signal,
    });
  } catch (err) {
    if (isTransientNetworkError(err)) {
      throw connectionError(err, url);
    }
    throw err;
  }

  if (!res.ok || !res.body) {
    const bodyText = res.body ? await res.text().catch(() => "") : "";
    throw new Error(`LLM 请求失败: HTTP ${res.status} ${bodyText}`.trim());
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice("data:".length).trim();
        if (payload === "[DONE]") return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = extractDelta(parsed);
        if (delta) yield delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface ChatCompletionOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** Called before EVERY HTTP attempt, including transport retries. Throws to deny a call. */
  beforeAttempt?: () => void;
  /** Optional provider output cap; preparation always supplies one. */
  maxOutputTokens?: number;
}

/**
 * Non-streaming chat completion, used by flashcards/generator.ts where the
 * whole response must be parsed as one JSON payload before anything is
 * persisted — streaming deltas would need to be buffered and re-joined
 * anyway, so this calls the same endpoint with `stream: false` instead.
 */
export async function requestChatCompletion(
  options: ChatCompletionOptions,
): Promise<string> {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let res: Response;
  try {
    res = await fetchLlm(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: false,
        ...(options.maxOutputTokens !== undefined ? { max_tokens: options.maxOutputTokens } : {}),
      }),
      signal: options.signal,
    }, options.beforeAttempt);
  } catch (err) {
    if (isTransientNetworkError(err)) {
      throw connectionError(err, url);
    }
    throw err;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`LLM 请求失败: HTTP ${res.status} ${bodyText}`.trim());
  }

  const body: unknown = await res.json();
  const content = extractMessageContent(body);
  if (typeof content !== "string") {
    throw new Error("LLM 返回格式异常：缺少 choices[0].message.content");
  }
  return content;
}

function extractMessageContent(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function extractDelta(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return undefined;
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}
