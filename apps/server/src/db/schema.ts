import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * MVP data model skeleton — placeholders for the six MVP feature areas.
 * Column-level detail is intentionally deferred to feature implementation
 * plans; this establishes owner boundaries only.
 */

export const materials = sqliteTable("materials", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  sourcePath: text("source_path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/**
 * A chunk of a parsed material, produced by materials/chunker.ts.
 * Owner: materials/ module. Consumed read-only by the dialogue engine
 * (stage 3) for context injection.
 */
export const materialChunks = sqliteTable("material_chunks", {
  id: text("id").primaryKey(),
  materialId: text("material_id").notNull(),
  order: integer("order").notNull(),
  title: text("title").notNull(),
  level: integer("level").notNull(),
  content: text("content").notNull(),
});

/**
 * A learning session is anchored to exactly one material chunk:
 * the dialogue engine only ever injects one chunk's content as context.
 */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  materialId: text("material_id").notNull(),
  chunkId: text("chunk_id").notNull(),
  /**
   * v3: the session anchors to a lesson (course-prep layer). Nullable on
   * purpose — NULL marks v2 legacy sessions, which are read-only (POST
   * messages returns 409 legacy_session_readonly; history/export intact).
   */
  lessonId: text("lesson_id"),
  /** Immutable quality-first card binding; NULL until the new runtime cutover. */
  cardVersion: text("card_version"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  /**
   * Millisecond precision is required here: dialogue/store.ts appendExchange
   * writes the assistant row 1ms after the user row to keep listMessages'
   * ascending order deterministic. The default "timestamp" mode stores
   * whole seconds (mapToDriverValue floors to /1e3), which would collapse
   * both rows onto the same value and make the pair's order ambiguous.
   */
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const flashcards = sqliteTable("flashcards", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  question: text("question").notNull(),
  options: text("options"),
  answer: text("answer").notNull(),
  explanation: text("explanation"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/**
 * Current pedagogy-reducer snapshot, one row per session. Derivable from
 * session_turns via the pure reducer (strategy.ts) — if the two ever diverge,
 * turns are the source of truth. No row = default state (legacy sessions
 * degrade gracefully on their next send). Owner: pedagogy/store.ts.
 */
export const sessionPedagogyState = sqliteTable("session_pedagogy_state", {
  sessionId: text("session_id").primaryKey(),
  hintLevel: integer("hint_level").notNull().default(0),
  stuckCounter: integer("stuck_counter").notNull().default(0),
  consecutiveNoCoverage: integer("consecutive_no_coverage").notNull().default(0),
  turnsOnFocus: integer("turns_on_focus").notNull().default(0),
  currentFocus: text("current_focus"),
  misconceptions: text("misconceptions").notNull().default("[]"),
  /**
   * v3: JSON string[] of mastered KP ids (closed-set coverage). The column
   * name predates v3 — it now carries KP ids instead of free-form coverage
   * labels; legacy free-form values are inert (read-only legacy sessions).
   */
  coveredPoints: text("covered_points").notNull().default("[]"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/**
 * Append-only evidence log, one row per exchange: the zod-validated
 * assessment and the chosen teaching action, linked to the persisted
 * user/assistant messages. Basis for evidence binding and future learning
 * reports. Owner: pedagogy/store.ts.
 */
export const sessionTurns = sqliteTable("session_turns", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  userMessageId: text("user_message_id").notNull(),
  assistantMessageId: text("assistant_message_id").notNull(),
  assessment: text("assessment").notNull(),
  action: text("action").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * v3 course-prep layer. An atomic teachable knowledge point extracted from a
 * chapter chunk, anchored to verbatim evidence quotes (must be exact
 * substrings of the owning section's content — machine-verified at prep time).
 * Owner: prep/store.ts.
 */
export const knowledgePoints = sqliteTable("knowledge_points", {
  id: text("id").primaryKey(),
  materialId: text("material_id").notNull(),
  chunkId: text("chunk_id").notNull(),
  /** Document order within the chapter (1-based, contiguous). */
  order: integer("order").notNull(),
  /** Single teachable proposition, ≤80 chars. */
  statement: text("statement").notNull(),
  type: text("type", {
    enum: [
      "fact", "concept", "classification", "relation", "mechanism", "formula",
      "model", "procedure", "strategy", "proof", "evaluation", "normative",
    ],
  }).notNull(),
  sectionIndex: integer("section_index").notNull(),
  sectionTitle: text("section_title").notNull(),
  /** JSON string[] of verbatim quotes from the section content. */
  evidence: text("evidence").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/**
 * v3: a lesson is the planned unit of one classroom session — an ordered
 * subsequence of the chapter's KP list (3–7 KPs by default), cut along
 * section boundaries. Sessions anchor here (sessions.lesson_id).
 * carryOutSummary is written deterministically at close-lesson time and feeds
 * the next lesson's opening message. Owner: prep/store.ts.
 */
export const lessons = sqliteTable("lessons", {
  id: text("id").primaryKey(),
  materialId: text("material_id").notNull(),
  chunkId: text("chunk_id").notNull(),
  order: integer("order").notNull(),
  title: text("title").notNull(),
  /** One-sentence objective generated at scheduling time. */
  objective: text("objective").notNull(),
  /** JSON string[] of KP ids in document order. */
  kpIds: text("kp_ids").notNull(),
  /** Deterministic carry-forward summary, written at lesson completion. */
  carryOutSummary: text("carry_out_summary"),
  /** True when the lesson came from the deterministic greedy packer (LLM
   * grouping failed validation twice) — visible, not a ghost path. */
  autoPacked: integer("auto_packed", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: ["active", "completed"] }).notNull().default("active"),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/** Immutable snapshots; publication never updates an existing version's payload. */
export const lessonCardVersions = sqliteTable("lesson_card_versions", {
  version: text("version").primaryKey(),
  lessonId: text("lesson_id").notNull(),
  taskId: text("task_id").notNull(),
  sourceHash: text("source_hash").notNull(),
  learnerVersion: text("learner_version").notNull(),
  rulesVersion: text("rules_version").notNull(),
  payload: text("payload").notNull(),
  publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
});

/** Durable work is owned by prep; generation fences stale executors. */
/** Structured diagnosis lifecycle with message evidence; legacy string summaries remain read-compatible. */
export const misconceptionRecords = sqliteTable("misconception_records", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  materialId: text("material_id").notNull(),
  label: text("label").notNull(),
  kpId: text("kp_id"),
  status: text("status", { enum: ["active", "uncertain", "resolved"] }).notNull(),
  evidenceMessageIds: text("evidence_message_ids").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => ({
  diagnosisIdentity: uniqueIndex("misconception_records_identity").on(table.sessionId, table.label, table.kpId),
}));

/** Validated semantic verdicts bound to real persisted answer messages. */
export const learningEvidence = sqliteTable("learning_evidence", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  cardVersion: text("card_version").notNull(),
  taskId: text("task_id").notNull(),
  requirementId: text("requirement_id").notNull(),
  userMessageId: text("user_message_id").notNull(),
  answerQuote: text("answer_quote").notNull(),
  verdict: text("verdict", { enum: ["satisfied", "not_satisfied", "uncertain"] }).notNull(),
  rationale: text("rationale").notNull(),
  assessmentVersion: text("assessment_version").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => ({
  evidenceIdentity: uniqueIndex("learning_evidence_identity").on(table.cardVersion, table.requirementId, table.userMessageId),
}));

/** Server-owned delivery record: binds an answer to a task/card independently of model assessment. */
export const taskAttempts = sqliteTable("task_attempts", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  cardVersion: text("card_version").notNull(),
  taskId: text("task_id").notNull(),
  userMessageId: text("user_message_id").notNull(),
  assistance: text("assistance", { enum: ["none", "hint", "explanation"] }).notNull(),
  observedPerformance: integer("observed_performance", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => ({
  attemptIdentity: uniqueIndex("task_attempts_identity").on(table.cardVersion, table.taskId, table.userMessageId),
}));

export const prepTasks = sqliteTable("prep_tasks", {
  id: text("id").primaryKey(),
  chunkId: text("chunk_id").notNull(),
  inputHash: text("input_hash").notNull(),
  rulesVersion: text("rules_version").notNull(),
  status: text("status", { enum: ["queued", "running", "paused", "succeeded", "failed", "cancelled"] }).notNull(),
  generation: integer("generation").notNull().default(0),
  reason: text("reason"),
  budget: text("budget").notNull(),
  callsUsed: integer("calls_used").notNull().default(0),
  tokensUsed: integer("tokens_used").notNull().default(0),
  leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => ({
  inputIdentity: uniqueIndex("prep_tasks_input_identity").on(table.chunkId, table.inputHash, table.rulesVersion),
}));

/** Only validated unit outputs are committed; inputHash includes source and configuration identity. */
export const prepCheckpoints = sqliteTable("prep_checkpoints", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => prepTasks.id, { onDelete: "cascade" }),
  unitKey: text("unit_key").notNull(),
  inputHash: text("input_hash").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => ({
  unitIdentity: uniqueIndex("prep_checkpoints_unit_identity").on(table.taskId, table.unitKey, table.inputHash),
}));

export type KnowledgePointType = (typeof knowledgePoints.type.enumValues)[number];
export type LessonStatusValue = (typeof lessons.status.enumValues)[number];

/**
 * v3: per-chapter prep status (lazy — one row per chapter that has been
 * prepared or failed preparing). No row = not_prepared. status=failed keeps
 * the error message for display and allows a full-chapter retry.
 * Owner: prep/store.ts.
 */
export const chunkPrep = sqliteTable("chunk_prep", {
  chunkId: text("chunk_id").primaryKey(),
  materialId: text("material_id").notNull(),
  status: text("status", { enum: ["ready", "failed"] }).notNull(),
  kpCount: integer("kp_count").notNull(),
  lessonCount: integer("lesson_count").notNull(),
  /** Sections still having audit gaps after the re-extraction retry. */
  partialSections: integer("partial_sections").notNull().default(0),
  autoPackedLessons: integer("auto_packed_lessons").notNull().default(0),
  error: text("error"),
  preparedAt: integer("prepared_at", { mode: "timestamp" }).notNull(),
});

/**
 * v3: per-material learner progress snapshot. Replayable from session_turns
 * (KP mastered = covered by one solid assessment) — same invariant pattern as
 * session_pedagogy_state. Owner: prep/store.ts.
 */
export const materialProgress = sqliteTable("material_progress", {
  materialId: text("material_id").primaryKey(),
  /** JSON string[] of mastered KP ids. */
  masteredKpIds: text("mastered_kp_ids").notNull().default("[]"),
  /** JSON string[] of unresolved misconception labels across sessions. */
  openMisconceptions: text("open_misconceptions").notNull().default("[]"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
