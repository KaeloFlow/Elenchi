import { z } from "zod";
import type { Db } from "../db/client.js";
import { claimPrepTask, finishPrepTask, pauseOwnedPrepTask, readPrepCheckpoint,
  reservePrepCall, savePrepCheckpoint } from "./task-store.js";

export interface PrepWorkUnit { key: string; inputHash: string; reservedTokens: number }
export interface ExecutePrepOptions<T> {
  db: Db; taskId: string; units: PrepWorkUnit[]; schema: z.ZodType<T>;
  /** Transport accounting uses requestPrepCompletion with the supplied generation. */
  runUnit: (unit: PrepWorkUnit, signal: AbortSignal, generation: number) => Promise<T>;
  accounting?: "unit" | "transport";
  /** Runs while the lease/generation is still valid, immediately before success. */
  beforeFinish?: (outputs: T[], generation: number) => boolean | Promise<boolean>;
  signal?: AbortSignal;
}

/** Runs validated units sequentially. Completion means work finished, never lesson ready. */
export async function executePrepUnits<T>(options: ExecutePrepOptions<T>): Promise<{ completed: boolean; outputs: T[] }> {
  const { db, taskId } = options;
  const task = claimPrepTask(db, taskId);
  if (!task) return { completed: false, outputs: [] };
  const controller = new AbortController();
  const deadline = task.leaseUntil!.getTime();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new Error("prep_deadline_exceeded")), Math.max(0, deadline - Date.now()));
  const outputs: T[] = [];
  try {
    for (const unit of options.units) {
      controller.signal.throwIfAborted();
      const cached = readPrepCheckpoint(db, taskId, unit.key, unit.inputHash, options.schema);
      if (cached !== undefined) { outputs.push(cached); continue; }
      if (options.accounting !== "transport" && !reservePrepCall(db, taskId, task.generation, unit.reservedTokens)) {
        pauseOwnedPrepTask(db, taskId, task.generation, "lease_or_budget_unavailable");
        return { completed: false, outputs };
      }
      const output = await options.runUnit(unit, controller.signal, task.generation);
      controller.signal.throwIfAborted();
      const parsed = options.schema.parse(output);
      if (!savePrepCheckpoint(db, { taskId, generation: task.generation,
        unitKey: unit.key, inputHash: unit.inputHash, payload: parsed }, options.schema)) return { completed: false, outputs };
      outputs.push(parsed);
    }
    if (options.beforeFinish && !(await options.beforeFinish(outputs, task.generation))) {
      pauseOwnedPrepTask(db, taskId, task.generation, "finalization_rejected");
      return { completed: false, outputs };
    }
    return { completed: finishPrepTask(db, taskId, task.generation), outputs };
  } catch (error) {
    pauseOwnedPrepTask(db, taskId, task.generation,
      controller.signal.aborted ? "cancelled_or_timed_out" : "unit_failed");
    return { completed: false, outputs };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
