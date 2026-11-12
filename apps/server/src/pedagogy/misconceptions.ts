export type MisconceptionStatus = "active" | "uncertain" | "resolved";
export interface MisconceptionRecord { label: string; kpId: string | null; status: MisconceptionStatus; evidenceMessageIds: string[] }

/** Conservative lifecycle: unrelated correctness never resolves a diagnosis. */
export function evolveMisconceptions(input: { current: MisconceptionRecord[]; diagnosed: string[]; targetKpId: string | null; evidenceSatisfiedKpIds: string[]; evidenceMessageId: string }): MisconceptionRecord[] {
  const satisfied = new Set(input.evidenceSatisfiedKpIds);
  const next = input.current.map((item) => ({ ...item, evidenceMessageIds: [...item.evidenceMessageIds] }));
  for (const item of next) {
    // A successful independent task on the same target weakens, but cannot erase,
    // a prior diagnosis: later transfer/retest is required for resolved.
    if (item.kpId !== null && satisfied.has(item.kpId) && !input.diagnosed.includes(item.label)) {
      if (!item.evidenceMessageIds.includes(input.evidenceMessageId)) item.evidenceMessageIds.push(input.evidenceMessageId);
      if (item.status === "active") item.status = "uncertain";
      else if (item.status === "uncertain" && item.evidenceMessageIds.length >= 3) item.status = "resolved";
    }
  }
  for (const label of input.diagnosed) {
    const existing = next.find((item) => item.label === label && item.kpId === input.targetKpId);
    if (existing) { existing.status = "active"; existing.evidenceMessageIds.push(input.evidenceMessageId); }
    else next.push({ label, kpId: input.targetKpId, status: "active", evidenceMessageIds: [input.evidenceMessageId] });
  }
  return next;
}
