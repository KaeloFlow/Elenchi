import { randomUUID } from "node:crypto";
import { and, eq, gt, sql, desc } from "drizzle-orm";
import { z } from "zod";
import { PrepBudgetSchema } from "@elenchi/shared";
import type { Db } from "../db/client.js";
import { prepTasks, prepCheckpoints } from "../db/schema.js";

const Identity = z.object({
  chunkId: z.string().min(1), inputHash: z.string().min(1), rulesVersion: z.string().min(1),
  budget: PrepBudgetSchema,
}).strict();
export type TaskIdentity = z.infer<typeof Identity>;
export function getPrepTask(db: Db, id: string) {
  return db.select().from(prepTasks).where(eq(prepTasks.id, id)).get();
}

/** Returns the newest durable task for a chunk, including paused/running work. */
export function getLatestPrepTaskForChunk(db: Db, chunkId: string) {
  return db.select().from(prepTasks).where(eq(prepTasks.chunkId, chunkId)).orderBy(desc(prepTasks.updatedAt)).get();
}

export function countPrepCheckpoints(db: Db, taskId: string): number {
  return db.select().from(prepCheckpoints).where(eq(prepCheckpoints.taskId, taskId)).all().length;
}

/** Idempotent identity creation never resets an existing task's budget or state. */
export function ensurePrepTask(db: Db, input: TaskIdentity, now = new Date()) {
  const value = Identity.parse(input);
  db.insert(prepTasks).values({
    id: randomUUID(), chunkId: value.chunkId, inputHash: value.inputHash,
    rulesVersion: value.rulesVersion, budget: JSON.stringify(value.budget),
    status: "queued", createdAt: now, updatedAt: now,
  }).onConflictDoNothing().run();
  return db.select().from(prepTasks).where(and(
    eq(prepTasks.chunkId, value.chunkId), eq(prepTasks.inputHash, value.inputHash),
    eq(prepTasks.rulesVersion, value.rulesVersion),
  )).get()!;
}

/** Claim only queued work. The lease is the finite execution-window deadline. */
export function claimPrepTask(db: Db, id: string, now = new Date()) {
  const task = getPrepTask(db, id);
  if (!task || task.status !== "queued") return undefined;
  const budget = PrepBudgetSchema.parse(JSON.parse(task.budget));
  return db.update(prepTasks).set({
    status: "running", generation: sql`${prepTasks.generation} + 1`, reason: null,
    leaseUntil: new Date(now.getTime() + budget.maxDurationMs), updatedAt: now,
  }).where(and(eq(prepTasks.id, id), eq(prepTasks.status, "queued"), eq(prepTasks.generation, task.generation)))
    .returning().get();
}

function fence(id: string, generation: number, now: Date) {
  return and(eq(prepTasks.id, id), eq(prepTasks.status, "running"),
    eq(prepTasks.generation, generation), gt(prepTasks.leaseUntil, now));
}

/** Reserve before a call; conservative token reservations are never refunded after uncertain failures. */
export function reservePrepCall(db: Db, id: string, generation: number, tokens: number, now = new Date()): boolean {
  z.number().int().nonnegative().safe().parse(tokens);
  return db.transaction((tx) => {
    const task = tx.select().from(prepTasks).where(fence(id, generation, now)).get();
    if (!task) return false;
    const budget = PrepBudgetSchema.parse(JSON.parse(task.budget));
    if (task.callsUsed >= budget.maxCalls || tokens > budget.maxTokens - task.tokensUsed) {
      tx.update(prepTasks).set({ status: "paused", reason: "budget_exhausted", leaseUntil: null,
        generation: task.generation + 1, updatedAt: now }).where(fence(id, generation, now)).run();
      return false;
    }
    return tx.update(prepTasks).set({ callsUsed: task.callsUsed + 1,
      tokensUsed: task.tokensUsed + tokens, updatedAt: now }).where(fence(id, generation, now)).returning().get() !== undefined;
  });
}

/** Caller supplies the unit's runtime schema: unvalidated model output cannot become a checkpoint. */
export function savePrepCheckpoint<T>(db: Db, input: {
  taskId: string; generation: number; unitKey: string; inputHash: string; payload: T;
}, schema: z.ZodType<T>, now = new Date()): boolean {
  z.string().min(1).parse(input.unitKey);
  z.string().min(1).parse(input.inputHash);
  const payload = JSON.stringify(schema.parse(input.payload));
  if (payload === undefined) throw new Error("Checkpoint must be JSON serializable");
  return db.transaction((tx) => {
    if (!tx.select().from(prepTasks).where(fence(input.taskId, input.generation, now)).get()) return false;
    tx.insert(prepCheckpoints).values({ id: randomUUID(), taskId: input.taskId,
      unitKey: input.unitKey, inputHash: input.inputHash, payload, createdAt: now })
      .onConflictDoNothing().run();
    return true;
  });
}

export function readPrepCheckpoint<T>(db: Db, taskId: string, unitKey: string, inputHash: string, schema: z.ZodType<T>): T | undefined {
  const row = db.select().from(prepCheckpoints).where(and(eq(prepCheckpoints.taskId, taskId),
    eq(prepCheckpoints.unitKey, unitKey), eq(prepCheckpoints.inputHash, inputHash))).get();
  return row ? schema.parse(JSON.parse(row.payload)) : undefined;
}

export function stopPrepTask(db: Db, id: string, status: "paused" | "cancelled", reason: string, now = new Date()) {
  return db.update(prepTasks).set({ status, reason, leaseUntil: null,
    generation: sql`${prepTasks.generation} + 1`, updatedAt: now })
    .where(and(eq(prepTasks.id, id), sql`${prepTasks.status} IN ('queued', 'running', 'paused')`)).returning().get();
}

/** User-triggered continuation only; retains all already-spent call/token budget. */
export function resumePrepTask(db: Db, id: string, now = new Date()) {
  return db.update(prepTasks).set({ status: "queued", reason: null, updatedAt: now })
    .where(and(eq(prepTasks.id, id), eq(prepTasks.status, "paused"))).returning().get();
}

export function finishPrepTask(db: Db, id: string, generation: number, now = new Date()): boolean {
  return db.update(prepTasks).set({ status: "succeeded", leaseUntil: null, updatedAt: now })
    .where(fence(id, generation, now)).returning().get() !== undefined;
}

/** An executor may pause only its own generation, even after its deadline expired. */
export function pauseOwnedPrepTask(db: Db, id: string, generation: number, reason: string, now = new Date()): boolean {
  return db.update(prepTasks).set({ status: "paused", reason, leaseUntil: null,
    generation: sql`${prepTasks.generation} + 1`, updatedAt: now })
    .where(and(eq(prepTasks.id, id), eq(prepTasks.status, "running"), eq(prepTasks.generation, generation)))
    .returning().get() !== undefined;
}

/** Startup recovery is local state only; it never starts paid work. */
export function recoverInterruptedPrepTasks(db: Db, now = new Date()): number {
  return db.update(prepTasks).set({ status: "paused", reason: "interrupted", leaseUntil: null,
    generation: sql`${prepTasks.generation} + 1`, updatedAt: now })
    .where(eq(prepTasks.status, "running")).returning().all().length;
}
