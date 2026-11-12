import { randomUUID } from "node:crypto";
import { eq, inArray, desc } from "drizzle-orm";
import type { Db, DbTx } from "../db/client.js";
import { sessionPedagogyState, sessionTurns } from "../db/schema.js";
import {
  PedagogyStateSchema,
  defaultPedagogyState,
  type Assessment,
  type PedagogyState,
  type TeachingAction,
} from "./schemas.js";

/**
 * Sole owner of session_turns / session_pedagogy_state persistence.
 * Invariant: turns are the source of truth; the state row is always
 * derivable from turns via the pure reducer (spec §5).
 */

export function assistanceFromPreviousAction(db: Db, sessionId: string): "none" | "hint" | "explanation" {
  const last = db.select().from(sessionTurns).where(eq(sessionTurns.sessionId, sessionId))
    .orderBy(desc(sessionTurns.createdAt), desc(sessionTurns.id)).get();
  if (!last) return "none";
  const action = JSON.parse(last.action) as TeachingAction;
  return action.actionType === "explain" ? "explanation" : action.actionType === "hint" ? "hint" : "none";
}

export function getPedagogyState(db: Db, sessionId: string): PedagogyState {
  const row = db
    .select()
    .from(sessionPedagogyState)
    .where(eq(sessionPedagogyState.sessionId, sessionId))
    .get();
  return row ? toState(row) : defaultPedagogyState(sessionId);
}

/**
 * Writes one turn row and upserts the reducer snapshot. Must run inside the
 * same transaction as appendExchange so a failed send leaves no partial
 * pedagogy evidence.
 */
export function recordTurnAndState(
  tx: DbTx,
  sessionId: string,
  userMessageId: string,
  assistantMessageId: string,
  assessment: Assessment,
  action: TeachingAction,
  state: PedagogyState,
): void {
  tx.insert(sessionTurns)
    .values({
      id: randomUUID(),
      sessionId,
      userMessageId,
      assistantMessageId,
      assessment: JSON.stringify(assessment),
      action: JSON.stringify(action),
      createdAt: new Date(),
    })
    .run();

  const updatedAt = new Date();
  const row = toRow(state, updatedAt);
  tx.insert(sessionPedagogyState)
    .values(row)
    .onConflictDoUpdate({
      target: sessionPedagogyState.sessionId,
      set: {
        hintLevel: row.hintLevel,
        stuckCounter: row.stuckCounter,
        consecutiveNoCoverage: row.consecutiveNoCoverage,
        turnsOnFocus: row.turnsOnFocus,
        currentFocus: row.currentFocus,
        misconceptions: row.misconceptions,
        coveredPoints: row.coveredPoints,
        updatedAt: row.updatedAt,
      },
    })
    .run();
}

/**
 * Cascade support: called from the materials delete transaction after
 * sessionIds are collected (same pattern as deleteSessionsAndMessages).
 */
export function deletePedagogyForSessions(
  tx: DbTx,
  sessionIds: string[],
): void {
  if (sessionIds.length === 0) return;
  tx.delete(sessionTurns)
    .where(inArray(sessionTurns.sessionId, sessionIds))
    .run();
  tx.delete(sessionPedagogyState)
    .where(inArray(sessionPedagogyState.sessionId, sessionIds))
    .run();
}

function toState(row: {
  sessionId: string;
  hintLevel: number;
  stuckCounter: number;
  consecutiveNoCoverage: number;
  turnsOnFocus: number;
  currentFocus: string | null;
  misconceptions: string;
  coveredPoints: string;
}): PedagogyState {
  return PedagogyStateSchema.parse({
    sessionId: row.sessionId,
    hintLevel: row.hintLevel,
    stuckCounter: row.stuckCounter,
    consecutiveNoCoverage: row.consecutiveNoCoverage,
    turnsOnFocus: row.turnsOnFocus,
    currentFocus: row.currentFocus,
    misconceptions: JSON.parse(row.misconceptions) as string[],
    // The covered_points column carries v3 mastered KP ids (see schema.ts).
    masteredKpIds: JSON.parse(row.coveredPoints) as string[],
  });
}

function toRow(state: PedagogyState, updatedAt: Date) {
  return {
    sessionId: state.sessionId,
    hintLevel: state.hintLevel,
    stuckCounter: state.stuckCounter,
    consecutiveNoCoverage: state.consecutiveNoCoverage,
    turnsOnFocus: state.turnsOnFocus,
    currentFocus: state.currentFocus,
    misconceptions: JSON.stringify(state.misconceptions),
    coveredPoints: JSON.stringify(state.masteredKpIds),
    updatedAt,
  };
}
