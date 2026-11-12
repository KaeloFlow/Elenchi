import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { LessonDto, MessageDto } from "@elenchi/shared";
import { fetchChunkLessons } from "../features/materials/api.js";
import { fetchLessonKps, fetchLessonQualitySummary } from "../features/lessons/api.js";
import { createSession, fetchEvidenceProgress, fetchMessages, fetchSessionMisconceptions, sendMessage } from "../features/dialogue/api.js";
import type { LessonKpDto } from "@elenchi/shared";
import { KnowledgeRow, StateBar } from "../ui/bits.js";

type LessonLoad =
  | { kind: "loading" }
  | { kind: "ready"; lesson: LessonDto; sessionId: string; messages: MessageDto[]; kps: LessonKpDto[]; quality: Awaited<ReturnType<typeof fetchLessonQualitySummary>> }
  | { kind: "error"; message: string };

/**
 * The classroom (spec §4.6). Full-height three-band layout: lesson header,
 * scrolling dialogue (left) + always-on workbench (right), input docked at
 * the bottom of the classroom column. Sends stream the tutor's reply via
 * SSE; a completed lesson routes to the complete page.
 */
export function LessonScreen({
  chunkId,
  lessonId,
  onSessionKnown,
  onCompleted,
  onExit,
}: {
  chunkId: string;
  lessonId: string;
  onSessionKnown: (sessionId: string) => void;
  onCompleted: () => void;
  onExit: () => void;
}) {
  const [load, setLoad] = useState<LessonLoad>({ kind: "loading" });
  const [lesson, setLesson] = useState<LessonDto | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [kps, setKps] = useState<LessonKpDto[]>([]);
  const [quality, setQuality] = useState<Awaited<ReturnType<typeof fetchLessonQualitySummary>> | null>(null);
  const [evidenceProgress, setEvidenceProgress] = useState<Awaited<ReturnType<typeof fetchEvidenceProgress>> | null>(null);
  const [misconceptions, setMisconceptions] = useState<Awaited<ReturnType<typeof fetchSessionMisconceptions>> | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [waitingPlaceholder, setWaitingPlaceholder] = useState("写下你的判断…");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamingTextRef = useRef("");

  const refreshProgress = useCallback(async (): Promise<LessonDto | null> => {
    if (!sessionId || !lesson) return null;
    const [lessonsBody, kpsBody, evidenceBody, misconceptionBody] = await Promise.all([
      fetchChunkLessons(chunkId).catch(() => null),
      fetchLessonKps(lesson.id).catch(() => null),
      sessionId ? fetchEvidenceProgress(sessionId).catch(() => null) : Promise.resolve(null),
      sessionId ? fetchSessionMisconceptions(sessionId).catch(() => null) : Promise.resolve(null),
    ]);
    let refreshed: LessonDto | null = null;
    if (lessonsBody?.lessons) {
      refreshed = lessonsBody.lessons.find((l) => l.id === lesson.id) ?? null;
      if (refreshed) setLesson(refreshed);
    }
    if (kpsBody) setKps(kpsBody.kps);
    if (evidenceBody) setEvidenceProgress(evidenceBody);
    if (misconceptionBody) setMisconceptions(misconceptionBody);
    return refreshed;
  }, [sessionId, lesson, chunkId]);

  // Enter the classroom: resolve the lesson, create/reuse its session,
  // load history + workbench KP list.
  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    (async () => {
      try {
        const lessonsBody = await fetchChunkLessons(chunkId);
        const found = lessonsBody.lessons?.find((l) => l.id === lessonId);
        if (!found) throw new Error("lesson_not_found");
        const session = await createSession(found.id);
        const [history, kpsBody, qualityBody, evidenceBody, misconceptionBody] = await Promise.all([
          fetchMessages(session.id),
          fetchLessonKps(found.id),
          fetchLessonQualitySummary(found.id),
          fetchEvidenceProgress(session.id),
          fetchSessionMisconceptions(session.id),
        ]);
        if (cancelled) return;
        setLesson(found);
        setSessionId(session.id);
        setMessages(history);
        setKps(kpsBody.kps);
        setQuality(qualityBody);
        setEvidenceProgress(evidenceBody);
        setMisconceptions(misconceptionBody);
        setLoad({
          kind: "ready",
          lesson: found,
          sessionId: session.id,
          messages: history,
          kps: kpsBody.kps,
          quality: qualityBody,
        });
        onSessionKnown(session.id);
      } catch (err) {
        if (cancelled) return;
        setLoad({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunkId, lessonId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streamingText]);

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionId || !lesson) return;
    if (!draft.trim()) {
      setWaitingPlaceholder("先写下你的判断，再提交。");
      inputRef.current?.focus();
      return;
    }
    if (sending) return;

    const userText = draft;
    const pendingId = `pending-${Date.now()}`;
    setDraft("");
    setWaitingPlaceholder("已提交，等待下一轮追问…");
    setMessages((prev) => [
      ...prev,
      {
        id: pendingId,
        sessionId,
        role: "user",
        content: userText,
        createdAt: Date.now(),
      },
    ]);
    setSending(true);
    setSendError(null);
    streamingTextRef.current = "";
    setStreamingText("");

    // Failure keeps everything on-page: the optimistic bubble is removed
    // and the typed text returns to the input (spec §5: 不离开当前页面).
    const rollback = () => {
      setMessages((prev) => prev.filter((m) => m.id !== pendingId));
      setDraft(userText);
      setWaitingPlaceholder("写下你的判断…");
    };

    await sendMessage(sessionId, userText, {
      onDelta: (delta) => {
        streamingTextRef.current += delta;
        setStreamingText(streamingTextRef.current);
      },
      onDone: (userMessageId, assistantMessageId, createdAt) => {
        const assistantContent = streamingTextRef.current;
        streamingTextRef.current = "";
        setStreamingText(null);
        setMessages((prev) => [
          ...prev.map((m) => (m.id === pendingId ? { ...m, id: userMessageId } : m)),
          { id: assistantMessageId, sessionId, role: "assistant", content: assistantContent, createdAt },
        ]);
        setSending(false);
        void refreshProgress()
          .then((refreshed) => {
            // Whole lesson mastered → the server marked the lesson
            // completed → route to the completion page (spec §4.6).
            if (refreshed?.status === "completed") onCompleted();
          })
          .catch(() => undefined);
      },
      onError: (message) => {
        setSendError(message);
        setStreamingText(null);
        setSending(false);
        rollback();
      },
    });
  };

  if (load.kind === "loading") {
    return (
      <section className="screen lesson-shell active" data-od-id="classroom-page">
        <StateBar odId="lesson-loading">正在进入课堂…</StateBar>
      </section>
    );
  }

  if (load.kind === "error") {
    return (
      <section className="screen lesson-shell active" data-od-id="classroom-page">
        <header className="lesson-top">
          <button type="button" className="back" onClick={onExit}>
            返回课程列表
          </button>
        </header>
        <StateBar variant="error" odId="lesson-error">
          <span>无法进入课堂：{load.message}</span>
          <button type="button" className="button" onClick={onExit}>
            返回课程列表
          </button>
        </StateBar>
      </section>
    );
  }

  const displayed = lesson;
  if (!displayed) return null;
  const assistantSeen = messages.some((m) => m.role === "assistant");
  const turnLabel = (m: MessageDto) =>
    m.role === "user" ? "你的回答" : assistantSeen && m !== messages[0] ? "ELENCHI · 追问" : "ELENCHI";

  return (
    <section className="screen lesson-shell active" data-od-id="classroom-page">
      <header className="lesson-top" data-od-id="lesson-header">
        <button type="button" className="back" onClick={onExit}>
          返回课程列表
        </button>
        <span className="course-name">
          第 <span className="num">{displayed.order}</span> 课 · {displayed.title}
        </span>
        <span className="lesson-goal">学习目标：{displayed.objective}</span>
        <span className="mastery">
          已掌握 <span className="num">{displayed.masteredKpCount}</span> /{" "}
          <span className="num">{displayed.kpCount}</span>
        </span>
        <span className="workbench-status" data-od-id="workbench-status">工作台</span>
        <span className="workbench-status" data-od-id="quality-status">{quality?.cardVersion ? `课卡 ${quality.independentRequirementCount}/${quality.requirementCount} 条独立要求 · ${quality.taskCount} 个任务` : "未发布证据课卡"}</span>
        {evidenceProgress?.cardVersion && <span className="workbench-status" data-od-id="evidence-progress">证据 {evidenceProgress.satisfiedRequirementCount}/{evidenceProgress.totalRequirementCount} 满足 · {evidenceProgress.uncertainRequirementCount} 待复核 · {evidenceProgress.notSatisfiedRequirementCount} 未满足</span>}
        {misconceptions && misconceptions.records.length > 0 && <span className="workbench-status" data-od-id="misconception-status">误解 {misconceptions.records.filter((r) => r.status === "active").length} 个待处理 · {misconceptions.records.filter((r) => r.status === "uncertain").length} 个待复核 · {misconceptions.records.filter((r) => r.status === "resolved").length} 个已解决</span>}
      </header>

      <div className="workspace">
        <main className="classroom">
          <div className="dialogue" ref={scrollRef} data-od-id="lesson-dialogue" role="log" aria-label="课堂对话">
            {messages.map((m) => (
              <article className={m.role === "user" ? "turn" : "turn ai"} key={m.id}>
                <div className="turn-label">{turnLabel(m)}</div>
                <p>{m.content}</p>
              </article>
            ))}
            {streamingText !== null && (
              <article className="turn ai">
                <div className="turn-label">ELENCHI · 追问</div>
                <p>{streamingText}</p>
              </article>
            )}
          </div>

          {sendError && (
            <StateBar variant="error" odId="lesson-send-error">
              <span>发送失败：{sendError}</span>
            </StateBar>
          )}

          <form className="answer-box" data-od-id="answer-control" onSubmit={handleSend}>
            <input
              ref={inputRef}
              id="answer"
              aria-label="回答问题"
              placeholder={waitingPlaceholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={sending}
            />
            <div className="answer-footer">
              <span className="hint">Enter 提交 · 可用自己的话表达</span>
              <button type="submit" className="button primary" disabled={sending}>
                提交回答
              </button>
            </div>
          </form>

          <div className="mobile-workbench panel" data-od-id="mobile-workbench">
            <h2>本课工作台</h2>
            <p className="mastery">
              已掌握 <span className="num">{displayed.masteredKpCount}</span> /{" "}
              <span className="num">{displayed.kpCount}</span> 个知识点
            </p>
            {kps.map((kp) => (
              <KnowledgeRow key={kp.id} statement={kp.statement} done={kp.mastered} />
            ))}
          </div>
        </main>

        <aside className="workbench" id="workbench" data-od-id="workbench">
          <h2>本课工作台</h2>
          <span className="mastery">
            已掌握 <span className="num">{displayed.masteredKpCount}</span> /{" "}
            <span className="num">{displayed.kpCount}</span> 个知识点
          </span>
          {kps.map((kp) => (
            <KnowledgeRow key={kp.id} statement={kp.statement} done={kp.mastered} />
          ))}
        </aside>
      </div>
    </section>
  );
}
