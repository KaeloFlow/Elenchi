import { z } from "zod";

/**
 * Shared health-check response contract between server and web.
 */
export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  dataDir: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
