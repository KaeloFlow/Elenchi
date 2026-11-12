import type { ReactNode } from "react";

/**
 * Shared feedback container (spec §5): default = in-progress, `success`,
 * `error`; error copy must carry cause + next action. `coverage` variant
 * renders the amber audit bar on the courses page.
 */
export function StateBar({
  variant,
  odId,
  children,
}: {
  variant?: "success" | "error" | "coverage";
  odId: string;
  children: ReactNode;
}) {
  const cls = variant ? `state ${variant}` : "state";
  return (
    <div className={cls} role="status" data-od-id={odId}>
      {children}
    </div>
  );
}

/** Knowledge-point row with its mastery dot (workbench / complete page). */
export function KnowledgeRow({
  statement,
  done,
}: {
  statement: string;
  done: boolean;
}) {
  return (
    <div className="knowledge">
      <span className={done ? "dot done" : "dot"} aria-hidden="true" />
      <span>{statement}</span>
    </div>
  );
}
