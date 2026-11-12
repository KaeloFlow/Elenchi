import { z } from "zod";

/**
 * LLM connection settings the user provides on first run.
 * Persisted server-side; apiKey is masked before being sent to the client
 * (see settings/store.ts maskApiKey).
 */
export const LlmSettingsInputSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  /** Model identifier passed as `model` in chat completion requests. */
  model: z.string().min(1),
});
export type LlmSettingsInput = z.infer<typeof LlmSettingsInputSchema>;

/**
 * Update payload for PUT /api/settings once settings already exist. Unlike
 * LlmSettingsInputSchema (the full write contract used by settings/store.ts
 * writeSettings), apiKey is optional here: the server only ever returns a
 * masked apiKeyPreview, so "change model without re-entering the key" is
 * expressed by omitting apiKey — the route then keeps the stored key.
 */
export const UpdateLlmSettingsInputSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1),
});
export type UpdateLlmSettingsInput = z.infer<typeof UpdateLlmSettingsInputSchema>;

/**
 * Connection verification only needs baseUrl + apiKey (it probes {baseUrl}/models);
 * model is irrelevant until an actual chat completion is issued, so this is a
 * narrower schema than LlmSettingsInputSchema rather than reusing it.
 */
export const TestConnectionInputSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
});
export type TestConnectionInput = z.infer<typeof TestConnectionInputSchema>;

export const LlmSettingsResponseSchema = z.object({
  configured: z.boolean(),
  baseUrl: z.string().nullable(),
  apiKeyPreview: z.string().nullable(),
  model: z.string().nullable(),
});
export type LlmSettingsResponse = z.infer<typeof LlmSettingsResponseSchema>;

export const TestConnectionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export type TestConnectionResult = z.infer<typeof TestConnectionResultSchema>;
