import { z } from "zod";

/**
 * Contracts for the flashcard system (MVP stage 4). Flashcards are extracted
 * from a session's dialogue history on demand (user clicks "生成闪卡").
 */

export const FlashcardSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  question: z.string(),
  /** Multiple-choice options; null/omitted for open-ended cards. */
  options: z.array(z.string()).nullable(),
  answer: z.string(),
  /** Explanation shown after the user reveals the answer; optional. */
  explanation: z.string().nullable(),
  createdAt: z.number(),
});
export type FlashcardDto = z.infer<typeof FlashcardSchema>;

export const GenerateFlashcardsResponseSchema = z.object({
  flashcards: z.array(FlashcardSchema),
});
export type GenerateFlashcardsResponse = z.infer<
  typeof GenerateFlashcardsResponseSchema
>;

export const UpdateFlashcardInputSchema = z
  .object({
    question: z.string().min(1).optional(),
    options: z.array(z.string()).nullable().optional(),
    answer: z.string().min(1).optional(),
    explanation: z.string().nullable().optional(),
  })
  .refine((update) => Object.keys(update).length > 0, {
    message: "至少提供一个要更新的字段",
  });
export type UpdateFlashcardInput = z.infer<typeof UpdateFlashcardInputSchema>;

/**
 * Shape the LLM is instructed to return for extraction (see
 * dialogue/generator.ts). Validated with safeParse before any card is
 * persisted so a malformed LLM response never reaches the store as-is.
 */
export const ExtractedFlashcardSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).nullable().optional(),
  answer: z.string().min(1),
  explanation: z.string().nullable().optional(),
});
export type ExtractedFlashcard = z.infer<typeof ExtractedFlashcardSchema>;

export const ExtractedFlashcardsSchema = z.object({
  flashcards: z.array(ExtractedFlashcardSchema),
});
