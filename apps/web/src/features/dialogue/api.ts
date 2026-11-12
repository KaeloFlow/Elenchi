import { SessionEvidenceProgressSchema, SessionMisconceptionsResponseSchema, type SessionDto, type MessageDto, type DialogueStreamEvent, type SessionEvidenceProgress, type SessionMisconceptionsResponse } from "@elenchi/shared";

/**
 * Creates (or reuses) the lesson's session. On reuse the server omits
 * openingMessage — the client loads history via fetchMessages; on first
 * creation the tutor's opening message is included and already persisted.
 */
export async function createSession(
  lessonId: string,
): Promise<SessionDto & { openingMessage?: MessageDto }> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lessonId }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.details ?? body.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export async function fetchEvidenceProgress(sessionId: string): Promise<SessionEvidenceProgress> {
  const res = await fetch(`/api/sessions/${sessionId}/evidence-progress`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return SessionEvidenceProgressSchema.parse(await res.json());
}

export async function fetchSessionMisconceptions(sessionId: string): Promise<SessionMisconceptionsResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/misconceptions`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return SessionMisconceptionsResponseSchema.parse(await res.json());
}

export async function fetchMessages(sessionId: string): Promise<MessageDto[]> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface SendMessageCallbacks {
  onDelta: (delta: string) => void;
  onDone: (userMessageId: string, assistantMessageId: string, createdAt: number) => void;
  onError: (message: string) => void;
}

/**
 * Sends a user message and streams the assistant's reply. Cannot use
 * EventSource (browser-native SSE client) because this is a POST request;
 * instead reads the fetch response body stream directly and parses the same
 * `data: <json>\n\n` framing the server writes in dialogue/routes.ts.
 * Network failures (a rejected fetch or an aborted body stream — what the
 * user sees as "fetch failed") are routed to onError instead of throwing,
 * so the caller can roll back its optimistic UI.
 */
export async function sendMessage(
  sessionId: string,
  content: string,
  callbacks: SendMessageCallbacks,
): Promise<void> {
  let terminalEventReceived = false;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      callbacks.onError(
        (body.details as string) ?? (body.error as string) ?? `HTTP ${res.status}`,
      );
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const dispatch = (frame: string): boolean => {
      const line = frame.trim();
      if (!line.startsWith("data:")) return false;
      const payload = line.slice("data:".length).trim();

      let event: DialogueStreamEvent;
      try {
        event = JSON.parse(payload);
      } catch {
        return false;
      }

      if ("delta" in event) {
        callbacks.onDelta(event.delta);
        return false;
      }
      terminalEventReceived = true;
      if ("done" in event) {
        callbacks.onDone(event.userMessageId, event.messageId, event.createdAt);
      } else {
        callbacks.onError(event.error);
      }
      return true;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const frame of parts) {
        if (dispatch(frame)) return;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0 && dispatch(buffer)) return;
    if (!terminalEventReceived) {
      callbacks.onError("连接意外中断，请重试");
    }
  } catch (err) {
    if (!terminalEventReceived) {
      callbacks.onError(err instanceof Error ? err.message : String(err));
    }
  }
}
