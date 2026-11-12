import type {
  FlashcardDto,
  GenerateFlashcardsResponse,
  UpdateFlashcardInput,
} from "@elenchi/shared";

export async function generateFlashcards(
  sessionId: string,
): Promise<GenerateFlashcardsResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/flashcards/generate`, {
    method: "POST",
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.details ?? body.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export async function fetchFlashcards(sessionId: string): Promise<FlashcardDto[]> {
  const res = await fetch(`/api/sessions/${sessionId}/flashcards`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function updateFlashcard(
  id: string,
  input: UpdateFlashcardInput,
): Promise<FlashcardDto> {
  const res = await fetch(`/api/flashcards/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.details ?? body.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export async function deleteFlashcard(id: string): Promise<void> {
  const res = await fetch(`/api/flashcards/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    throw new Error(`HTTP ${res.status}`);
  }
}
