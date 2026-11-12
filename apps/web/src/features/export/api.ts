/**
 * Returns the URL of the server-rendered Markdown transcript for a session
 * (see apps/server/src/export/routes.ts `GET /api/sessions/:id/export.md`).
 * Pure function so it's testable without touching the DOM.
 */
export function transcriptMarkdownUrl(sessionId: string): string {
  return `/api/sessions/${sessionId}/export.md`;
}

/**
 * Triggers a browser download of the Markdown transcript. The server already
 * sends `Content-Disposition: attachment`, so a plain navigation (not a
 * fetch+blob round trip) is enough — same pattern as clicking a normal
 * download link.
 */
export function downloadTranscriptMarkdown(sessionId: string): void {
  const link = document.createElement("a");
  link.href = transcriptMarkdownUrl(sessionId);
  link.click();
}
