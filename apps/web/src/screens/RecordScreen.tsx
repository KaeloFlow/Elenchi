import { useEffect, useState } from "react";
import type { MessageDto } from "@elenchi/shared";
import { createSession, fetchMessages } from "../features/dialogue/api.js";
import { fetchChunkLessons } from "../features/materials/api.js";
import { transcriptMarkdownUrl } from "../features/export/api.js";
import { StateBar } from "../ui/bits.js";

/**
 * Transcript page (spec §4.9): the full classroom record with a natural
 * opening line, Markdown download (server-rendered attachment) and browser
 * printing via window.print() (print CSS outputs only the transcript).
 */
export function RecordScreen({
  chunkId,
  lessonId,
  onBackToLesson,
}: {
  chunkId: string;
  lessonId: string;
  onBackToLesson: () => void;
}) {
  const [lessonTitle, setLessonTitle] = useState("");
  const [lessonOrder, setLessonOrder] = useState<number | null>(null);
  const [mastered, setMastered] = useState(0);
  const [kpCount, setKpCount] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lessonsBody = await fetchChunkLessons(chunkId);
        const found = lessonsBody.lessons?.find((l) => l.id === lessonId) ?? null;
        const session = await createSession(lessonId);
        const history = await fetchMessages(session.id);
        if (cancelled) return;
        if (found) {
          setLessonTitle(found.title);
          setLessonOrder(found.order);
          setMastered(found.masteredKpCount);
          setKpCount(found.kpCount);
        }
        setSessionId(session.id);
        setMessages(history);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chunkId, lessonId]);

  return (
    <section className="screen active" data-od-id="transcript-page">
      <button type="button" className="back" onClick={onBackToLesson}>
        返回课堂
      </button>
      <div className="page-head" style={{ marginTop: 24 }}>
        <div>
          <p className="eyebrow">课堂实录</p>
          <h1 className="page-title">{lessonTitle || "课堂实录"}</h1>
          <p className="lead">
            {lessonOrder !== null && (
              <>
                第 <span className="num">{lessonOrder}</span> 课 · 已掌握{" "}
                <span className="num">{mastered}</span> / <span className="num">{kpCount}</span>{" "}
                个知识点
              </>
            )}
          </p>
        </div>
        <div className="row-actions record-actions">
          <a
            className="button"
            href={sessionId ? transcriptMarkdownUrl(sessionId) : undefined}
            aria-disabled={!sessionId}
            onClick={(e) => {
              if (!sessionId) e.preventDefault();
            }}
          >
            下载 Markdown
          </a>
          <button
            type="button"
            className="button primary"
            onClick={() => window.print()}
            disabled={loading || !!error}
          >
            打印 / 保存为 PDF
          </button>
        </div>
      </div>

      {error && (
        <StateBar variant="error" odId="record-error">
          <span>无法读取课堂实录：{error}</span>
          <button type="button" className="button" onClick={onBackToLesson}>
            返回课堂
          </button>
        </StateBar>
      )}
      {loading && <StateBar odId="record-loading">正在读取课堂实录…</StateBar>}

      {!loading && !error && (
        <article className="panel record transcript" data-od-id="transcript-body">
          <span className="meta">课堂开始</span>
          {messages.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>这节课还没有对话记录。</p>
          ) : (
            messages.map((m) => (
              <div key={m.id}>
                <h3>{m.role === "user" ? "你的回答" : "Elenchi"}</h3>
                <p>{m.content}</p>
              </div>
            ))
          )}
        </article>
      )}
    </section>
  );
}
