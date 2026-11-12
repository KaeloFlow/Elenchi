import type { FastifyInstance } from "fastify";
import {
  CreateSessionInputSchema,
  CreateSessionResponseSchema,
  SessionSchema,
  MessageSchema,
  SendMessageInputSchema,
  type DialogueStreamEvent,
} from "@elenchi/shared";
import type { Db } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import { readSettings } from "../settings/store.js";
import { getMaterialTitle, getChunkById } from "../materials/store.js";
import { splitSections } from "../prep/splitter.js";
import {
  findSessionByLessonId,
  getSession,
  listMessages,
  appendExchange,
  insertSessionWithOpening,
} from "./store.js";
import {
  buildSystemPrompt,
  buildOpeningPrompt,
  composeCarryOutSummary,
  type LessonCardContext,
  type LessonKpCard,
} from "./prompt.js";
import {
  streamChatCompletion,
  requestChatCompletion,
  type ChatMessage,
} from "./client.js";
import {
  assessAnswer,
  PedagogyAssessmentError,
} from "../pedagogy/assessment.js";
import { reduce } from "../pedagogy/strategy.js";
import {
  getPedagogyState,
  assistanceFromPreviousAction,
  recordTurnAndState,
} from "../pedagogy/store.js";
import { recordTaskAttempt, readTaskAttempts } from "../pedagogy/task-attempt-store.js";
import { recordLearningEvidence, readLearningEvidence } from "../pedagogy/learning-evidence-store.js";
import { evaluateMasteryEvidence } from "../pedagogy/evidence.js";
import { applyMisconceptionLifecycle, listSessionMisconceptionRecords } from "../pedagogy/misconception-store.js";
import { readPublishedCard } from "../prep/publication.js";
import {
  getLessonById,
  getLessonKps,
  getLessonLockState,
  getCarryOutSummary,
  markLessonCompleted,
  getMaterialProgress,
  updateMaterialProgress,
  type KpRecord,
  type LessonRecord,
} from "../prep/store.js";
import { SessionEvidenceProgressSchema, SessionMisconceptionsResponseSchema } from "@elenchi/shared";

function writeSseEvent(
  reply: { raw: { write: (chunk: string) => void } },
  event: DialogueStreamEvent,
): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function mergeUnique(base: string[], additions: string[]): string[] {
  const out = [...base];
  for (const item of additions) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Bounded section source text for the focus KP. Sections are re-derived from
 * the chapter chunk with the same deterministic splitter the prep pipeline
 * used — the chunk content is the source of truth and is never duplicated.
 */
function sectionContentOf(
  chunkContent: string,
  chapterLevel: number,
  sectionIndex: number | null,
  fallback: string,
): string {
  const sections = splitSections(chunkContent, chapterLevel);
  if (sectionIndex === null) {
    return sections[0]?.content ?? fallback;
  }
  return (
    sections.find((s) => s.index === sectionIndex)?.content ?? fallback
  );
}

/**
 * Builds the lesson card: KP list with mastery marks from the material
 * progress snapshot; the first unmastered planned KP is the target.
 */
function buildLessonCard(
  db: Db,
  materialTitle: string,
  chapterTitle: string,
  chunkContent: string,
  chunkLevel: number,
  lesson: LessonRecord,
  lessonKps: KpRecord[],
  targetKpId: string | null,
): { card: LessonCardContext; targetKp: KpRecord | null } {
  const progress = getMaterialProgress(db, lesson.materialId);
  const mastered = new Set(progress.masteredKpIds);
  const targetKp =
    lessonKps.find((kp) => kp.id === targetKpId) ??
    lessonKps.find((kp) => !mastered.has(kp.id)) ??
    lessonKps[0] ??
    null;
  const kpCards: LessonKpCard[] = lessonKps.map((kp) => ({
    id: kp.id,
    statement: kp.statement,
    type: kp.type,
    evidence: kp.evidence,
    mastered: mastered.has(kp.id),
    isTarget: targetKp !== null && kp.id === targetKp.id,
  }));
  const card: LessonCardContext = {
    materialTitle,
    chapterTitle,
    lessonTitle: lesson.title,
    objective: lesson.objective,
    kps: kpCards,
    focusSectionContent: targetKp
      ? sectionContentOf(
          chunkContent,
          chunkLevel,
          targetKp.sectionIndex,
          chunkContent.slice(0, 2000),
        )
      : null,
    carryInSummary: getCarryOutSummary(db, lesson.chunkId, lesson.order),
  };
  return { card, targetKp };
}

async function generateOpeningMessage(
  db: Db,
  materialTitle: string,
  chunk: { title: string; content: string; level: number },
  lesson: LessonRecord,
  settings: { baseUrl: string; apiKey: string; model: string },
): Promise<string> {
  const lessonKps = getLessonKps(db, lesson);
  const { card } = buildLessonCard(
    db,
    materialTitle,
    chunk.title,
    chunk.content,
    chunk.level,
    lesson,
    lessonKps,
    null,
  );
  const prompt = buildOpeningPrompt({ card });
  return requestChatCompletion({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    messages: [{ role: "user", content: prompt }],
  });
}

export function registerDialogueRoutes(
  app: FastifyInstance,
  db: Db,
  config: ServerConfig,
): void {
  app.post("/api/sessions", async (request, reply) => {
    const parseResult = CreateSessionInputSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400);
      return { error: "invalid_input", details: parseResult.error.flatten() };
    }

    try {
      // Existence checks before any generation work: an unknown lesson is a
      // client error (404), an unconfigured LLM is a precondition (400).
      const lesson = getLessonById(db, parseResult.data.lessonId);
      if (!lesson) {
        reply.code(404);
        return { error: "lesson_not_found" };
      }
      const settings = readSettings(config.dataDir);
      if (!settings) {
        reply.code(400);
        return { error: "llm_not_configured" };
      }

      const existing = findSessionByLessonId(db, lesson.id);
      if (existing) {
        // Reuse: the opening already exists in history; the client loads it
        // via GET /api/sessions/:id/messages (spec §8.1 reuse semantics).
        // Revisits are deliberately not gated — the gate only guards the
        // first entry, because that is when AI prep runs.
        return CreateSessionResponseSchema.parse({ ...existing });
      }

      // Lesson gate: the first entry into a lesson runs AI prep, which needs
      // the previous lesson's carry-out summary. Block first entries into a
      // lesson whose previous lesson is not completed yet (server-side
      // authority; the UI lock badge is derived from the same store rule).
      const lock = getLessonLockState(db, lesson);
      if (lock.locked) {
        reply.code(409);
        return {
          error: "lesson_locked",
          details: `需先完成第 ${lock.previousLessonOrder} 课「${lock.previousLessonTitle}」，AI 备课需要上一轮的学习情况。`,
        };
      }

      // New session: generate the tutor's opening (non-streaming), then
      // persist session + opening atomically. A generation failure leaves
      // no session row (explicit 502, zero persistence).
      const chunk = getChunkById(db, lesson.chunkId);
      if (!chunk) {
        reply.code(404);
        return { error: "chunk_not_found" };
      }
      const materialTitle =
        getMaterialTitle(db, lesson.materialId) ?? "未命名教材";
      const opening = await generateOpeningMessage(
        db,
        materialTitle,
        chunk,
        lesson,
        settings,
      );
      const saved = insertSessionWithOpening(db, lesson, opening);
      const openingMessage = listMessages(db, saved.id).find(
        (m) => m.role === "assistant",
      );
      return CreateSessionResponseSchema.parse({
        ...saved,
        openingMessage: openingMessage
          ? MessageSchema.parse(openingMessage)
          : undefined,
      });
    } catch (err) {
      reply.code(502);
      return {
        error: "opening_failed",
        details: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(db, id);
    if (!session) {
      reply.code(404);
      return { error: "session_not_found" };
    }
    return listMessages(db, id).map((m) => MessageSchema.parse(m));
  });

  app.get("/api/sessions/:id/evidence-progress", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(db, id);
    if (!session) { reply.code(404); return { error: "session_not_found" }; }
    if (!session.cardVersion || !session.lessonId) return SessionEvidenceProgressSchema.parse({ sessionId: id, cardVersion: null, totalRequirementCount: 0, satisfiedRequirementCount: 0, uncertainRequirementCount: 0, notSatisfiedRequirementCount: 0 });
    const card = readPublishedCard(db, session.cardVersion);
    if (!card) return SessionEvidenceProgressSchema.parse({ sessionId: id, cardVersion: session.cardVersion, totalRequirementCount: 0, satisfiedRequirementCount: 0, uncertainRequirementCount: 0, notSatisfiedRequirementCount: 0 });
    const evidence = readLearningEvidence(db, id, session.cardVersion);
    const latest = new Map<string, typeof evidence[number]>();
    for (const item of evidence) if (!latest.has(item.requirementId)) latest.set(item.requirementId, item);
    return SessionEvidenceProgressSchema.parse({ sessionId: id, cardVersion: session.cardVersion, totalRequirementCount: card.requirements.length,
      satisfiedRequirementCount: [...latest.values()].filter((item) => item.verdict === "satisfied").length,
      uncertainRequirementCount: [...latest.values()].filter((item) => item.verdict === "uncertain").length,
      notSatisfiedRequirementCount: [...latest.values()].filter((item) => item.verdict === "not_satisfied").length });
  });

  app.get("/api/sessions/:id/misconceptions", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getSession(db, id)) { reply.code(404); return { error: "session_not_found" }; }
    return SessionMisconceptionsResponseSchema.parse({ sessionId: id, records: listSessionMisconceptionRecords(db, id).map(({ label, kpId, status }) => ({ label, kpId, status })) });
  });

  app.post("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(db, id);
    if (!session) {
      reply.code(404);
      return { error: "session_not_found" };
    }
    if (session.lessonId === null) {
      // v2 legacy sessions are read-only: history and export work, teaching
      // runs only on lesson-anchored sessions (no dual teaching path).
      reply.code(409);
      return { error: "legacy_session_readonly" };
    }

    const parseResult = SendMessageInputSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400);
      return { error: "invalid_input", details: parseResult.error.flatten() };
    }

    const settings = readSettings(config.dataDir);
    if (!settings) {
      reply.code(400);
      return { error: "llm_not_configured" };
    }

    const lesson = getLessonById(db, session.lessonId);
    if (!lesson) {
      reply.code(404);
      return { error: "lesson_not_found" };
    }
    const chunk = getChunkById(db, session.chunkId);
    if (!chunk) {
      reply.code(404);
      return { error: "chunk_not_found" };
    }
    const materialTitle =
      getMaterialTitle(db, session.materialId) ?? "未命名教材";

    const lessonKps = getLessonKps(db, lesson);
    const boundTeachingCard = session.cardVersion ? readPublishedCard(db, session.cardVersion) : undefined;
    const attemptAssistance = assistanceFromPreviousAction(db, id);
    const stateBefore = getPedagogyState(db, id);
    const { card, targetKp } = buildLessonCard(
      db,
      materialTitle,
      chunk.title,
      chunk.content,
      chunk.level,
      lesson,
      lessonKps,
      null,
    );

    // Nothing is persisted before the pipeline succeeds: the new user
    // content joins the prompts in memory only, so a failed send leaves no
    // orphan user row.
    const history = listMessages(db, id);
    const userContent = parseResult.data.content;

    const assessmentTask = boundTeachingCard && targetKp ? boundTeachingCard.tasks.find((candidate) =>
      candidate.requirementIds.some((requirementId) => boundTeachingCard.requirements.some((requirement) => requirement.id === requirementId && requirement.kpId === targetKp.id)),
    ) : undefined;
    // Pipeline step 1: assess the answer against the lesson card
    // (non-streaming LLM call). A failed assessment is an explicit turn
    // failure — 502, zero persistence, no silent fallback.
    let assessment;
    try {
      assessment = await assessAnswer({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        context: {
          lessonKps: lessonKps.map((kp) => ({
            id: kp.id,
            statement: kp.statement,
            type: kp.type,
          })),
          targetKp: targetKp
            ? {
                id: targetKp.id,
                statement: targetKp.statement,
                type: targetKp.type,
              }
            : null,
          focusSectionContent: card.focusSectionContent ?? "",
          recentMessages: history.slice(-10).map((m) => ({
            role: m.role,
            content: m.content,
          })),
          userAnswer: userContent,
          taskScope: boundTeachingCard && assessmentTask ? { card: boundTeachingCard, taskId: assessmentTask.id } : undefined,
        },
      });
    } catch (err) {
      reply.code(502);
      return {
        error: "assessment_failed",
        details:
          err instanceof PedagogyAssessmentError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
      };
    }

    // Pipeline step 2: deterministic state update + action selection.
    const recentUserLengths = [
      ...history
        .filter((m) => m.role === "user")
        .map((m) => m.content.length),
      userContent.length,
    ].slice(-3);
    const { state: newState, action } = reduce({
      state: stateBefore,
      assessment,
      recentUserLengths,
      lessonContext: {
        kps: lessonKps.map((kp) => ({ id: kp.id, statement: kp.statement })),
        masteredKpIds: stateBefore.masteredKpIds,
      },
    });

    // The reducer may advance to another KP. Rebuild the whole card from that
    // canonical target instead of retaining the assessment target's source
    // section; generation must see one consistent target, mastery list, and
    // textbook context.
    const { card: reducedCard } = buildLessonCard(
      db,
      materialTitle,
      chunk.title,
      chunk.content,
      chunk.level,
      lesson,
      lessonKps,
      action.targetKpId,
    );
    const cardForTurn: LessonCardContext = {
      ...reducedCard,
      kps: reducedCard.kps.map((kp) => ({
        ...kp,
        mastered: kp.mastered || newState.masteredKpIds.includes(kp.id),
      })),
    };

    // Pipeline step 3: stream the generation call with the action directive.
    const systemPrompt = buildSystemPrompt({
      card: cardForTurn,
      stateSummary: {
        hintLevel: newState.hintLevel,
        stuckCounter: newState.stuckCounter,
        misconceptions: newState.misconceptions,
        masteredKpIds: newState.masteredKpIds,
      },
      action,
    });
    const chatMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userContent },
    ];

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.hijack();

    let assistantText = "";
    try {
      for await (const delta of streamChatCompletion({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: chatMessages,
      })) {
        assistantText += delta;
        writeSseEvent(reply, { delta });
      }

      if (assistantText.trim().length === 0) {
        // A normal stream end with no text is still a failed exchange —
        // nothing gets persisted and the client shows an error.
        writeSseEvent(reply, { error: "LLM 返回了空回复，请重试" });
      } else {
        // Pipeline step 4: single transaction — messages + turn + state +
        // lesson completion (+ carry-out) + material progress snapshot.
        const closingLesson = action.actionType === "close_lesson";
        const carryOut = closingLesson
          ? composeCarryOutSummary(
              lessonKps
                .filter((kp) => newState.masteredKpIds.includes(kp.id))
                .map((kp) => kp.statement),
              newState.misconceptions,
            )
          : null;
        const saved = appendExchange(
          db,
          id,
          userContent,
          assistantText,
          (tx, s) => {
            if (boundTeachingCard && targetKp) {
              const task = boundTeachingCard.tasks.find((candidate) =>
                candidate.requirementIds.some((requirementId) =>
                  boundTeachingCard.requirements.some((requirement) => requirement.id === requirementId && requirement.kpId === targetKp.id),
                ),
              );
              if (task && !recordTaskAttempt(tx, { sessionId: id, cardVersion: boundTeachingCard.version,
                taskId: task.id, userMessageId: s.user.id, assistance: attemptAssistance, observedPerformance: false })) {
                throw new Error("task_attempt_not_recorded");
              }
            }
            let evidenceState = newState;
            if (boundTeachingCard && assessmentTask) {
              for (const proposal of assessment.evidence) recordLearningEvidence(tx, { sessionId: id,
                cardVersion: boundTeachingCard.version, taskId: proposal.taskId, requirementId: proposal.requirementId,
                userMessageId: s.user.id, answerQuote: proposal.answerQuote, verdict: proposal.verdict,
                rationale: proposal.rationale, assessmentVersion: "quality-evidence-1" });
              const answerMap = new Map(listMessages(tx, id).filter((message) => message.role === "user").map((message) => [message.id, message.content]));
              answerMap.set(s.user.id, userContent);
              const evidenceResult = evaluateMasteryEvidence(boundTeachingCard,
                readLearningEvidence(tx, id, boundTeachingCard.version), readTaskAttempts(tx, id, answerMap));
              evidenceState = { ...newState, masteredKpIds: evidenceResult.masteredKpIds };
              applyMisconceptionLifecycle(tx, { sessionId: id, materialId: session.materialId,
                targetKpId: targetKp?.id ?? null, diagnosed: assessment.misconceptions,
                evidenceSatisfiedKpIds: evidenceResult.masteredKpIds, evidenceMessageId: s.user.id });
            }
            recordTurnAndState(
              tx,
              id,
              s.user.id,
              s.assistant.id,
              assessment,
              action,
              evidenceState,
            );
            if (closingLesson) {
              markLessonCompleted(tx, lesson.id, carryOut!);
            }
            const progress = getMaterialProgress(db, session.materialId);
            updateMaterialProgress(
              tx,
              session.materialId,
              mergeUnique(progress.masteredKpIds, evidenceState.masteredKpIds),
              mergeUnique(
                progress.openMisconceptions,
                newState.misconceptions,
              ),
            );
          },
        );
        writeSseEvent(reply, {
          done: true,
          messageId: saved.assistant.id,
          userMessageId: saved.user.id,
          createdAt: saved.assistant.createdAt,
        });
      }
    } catch (err) {
      writeSseEvent(reply, {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reply.raw.end();
    }
  });
}
