import { z } from "zod";
import type { Db } from "../db/client.js";
import { requestChatCompletion, type ChatMessage } from "../dialogue/client.js";
import { reservePrepCall } from "./task-store.js";

/** Conservative estimate only; provider-specific tokenizers may differ. */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + Buffer.byteLength(message.content, "utf8") + 32, 32);
}

export async function requestPrepCompletion(options: {
  db: Db; taskId: string; generation: number;
  baseUrl: string; apiKey: string; model: string;
  messages: ChatMessage[]; signal: AbortSignal;
  contextTokens: number; maxOutputTokens: number;
}): Promise<string> {
  const positive = z.number().int().positive().safe();
  positive.parse(options.contextTokens);
  positive.parse(options.maxOutputTokens);
  const reservation = estimateMessageTokens(options.messages) + options.maxOutputTokens;
  if (reservation > options.contextTokens) throw new Error("prep_context_budget_exceeded");
  return requestChatCompletion({ baseUrl: options.baseUrl, apiKey: options.apiKey,
    model: options.model, messages: options.messages, signal: options.signal,
    maxOutputTokens: options.maxOutputTokens,
    beforeAttempt: () => {
      if (!reservePrepCall(options.db, options.taskId, options.generation, reservation)) {
        throw new Error("prep_call_budget_unavailable");
      }
    },
  });
}
