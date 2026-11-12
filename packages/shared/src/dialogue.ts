import { z } from "zod";

/**
 * Contracts for the Socratic dialogue engine. v3: a session anchors to
 * exactly one lesson of the course-prep layer; v2 chunk-anchored
 * sessions survive as legacy read-only rows (lessonId = null).
 */

export const CreateSessionInputSchema = z.object({
  lessonId: z.string().min(1),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  materialId: z.string(),
  chunkId: z.string(),
  /** Null on v2 legacy sessions (read-only). */
  lessonId: z.string().nullable(),
  /** Immutable published card selected at session creation, null for old lessons. */
  cardVersion: z.string().nullable().default(null),
  startedAt: z.number(),
});
export type SessionDto = z.infer<typeof SessionSchema>;

export const MessageRoleSchema = z.enum(["user", "assistant"]);

export const MessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: z.number(),
});
export type MessageDto = z.infer<typeof MessageSchema>;

export const CreateSessionResponseSchema = SessionSchema.extend({
  /**
   * The tutor-generated opening message. Present only when a NEW session is
   * created (opening is generated at creation time); omitted when an
   * existing session is reused — the client then loads full history via
   * GET /api/sessions/:id/messages.
   */
  openingMessage: MessageSchema.optional(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const SendMessageInputSchema = z.object({
  content: z.string().min(1),
});
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

/**
 * Shape of each `data:` payload the server writes to the
 * `POST /api/sessions/:id/messages` SSE stream. Exactly one of `delta`,
 * `done`, or `error` is present per event.
 */
export const DialogueStreamEventSchema = z.union([
  z.object({ delta: z.string() }),
  z.object({
    done: z.literal(true),
    messageId: z.string(),
    /** Id of the persisted user message of this exchange; the web client
     * replaces its `pending-` placeholder id with this. */
    userMessageId: z.string(),
    createdAt: z.number(),
  }),
  z.object({ error: z.string() }),
]);
export type DialogueStreamEvent = z.infer<typeof DialogueStreamEventSchema>;
