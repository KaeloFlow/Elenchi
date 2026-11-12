import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db, DbTx } from "../db/client.js";
import { misconceptionRecords } from "../db/schema.js";
import { evolveMisconceptions, type MisconceptionRecord } from "./misconceptions.js";

/** Sole owner of structured misconception records for quality-card sessions. */
export function applyMisconceptionLifecycle(tx: DbTx, input: { sessionId: string; materialId: string; targetKpId: string | null; diagnosed: string[]; evidenceSatisfiedKpIds: string[]; evidenceMessageId: string }): MisconceptionRecord[] {
  const rows = tx.select().from(misconceptionRecords).where(eq(misconceptionRecords.sessionId, input.sessionId)).all();
  const current = rows.map((row) => ({ label: row.label, kpId: row.kpId, status: row.status, evidenceMessageIds: JSON.parse(row.evidenceMessageIds) as string[] })) as MisconceptionRecord[];
  const next = evolveMisconceptions({ current, diagnosed: input.diagnosed, targetKpId: input.targetKpId, evidenceSatisfiedKpIds: input.evidenceSatisfiedKpIds, evidenceMessageId: input.evidenceMessageId });
  const now = new Date();
  for (const item of next) {
    const existing = rows.find((row) => row.label === item.label && row.kpId === item.kpId);
    if (existing) tx.update(misconceptionRecords).set({ status: item.status, evidenceMessageIds: JSON.stringify(item.evidenceMessageIds), updatedAt: now }).where(eq(misconceptionRecords.id, existing.id)).run();
    else tx.insert(misconceptionRecords).values({ id: randomUUID(), sessionId: input.sessionId, materialId: input.materialId, label: item.label, kpId: item.kpId, status: item.status, evidenceMessageIds: JSON.stringify(item.evidenceMessageIds), createdAt: now, updatedAt: now }).run();
  }
  return next;
}
export function listSessionMisconceptionRecords(db: Db, sessionId: string): MisconceptionRecord[] {
  return db.select().from(misconceptionRecords).where(eq(misconceptionRecords.sessionId, sessionId)).all().map((row) => ({ label: row.label, kpId: row.kpId, status: row.status as MisconceptionRecord["status"], evidenceMessageIds: JSON.parse(row.evidenceMessageIds) as string[] }));
}

export function listMisconceptionRecords(db: Db, materialId: string): MisconceptionRecord[] {
  return db.select().from(misconceptionRecords).where(eq(misconceptionRecords.materialId, materialId)).all().map((row) => ({ label: row.label, kpId: row.kpId, status: row.status as MisconceptionRecord["status"], evidenceMessageIds: JSON.parse(row.evidenceMessageIds) as string[] }));
}
