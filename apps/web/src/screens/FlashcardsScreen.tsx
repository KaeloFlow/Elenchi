import { useEffect, useRef, useState } from "react";
import type { FlashcardDto } from "@elenchi/shared";
import { createSession } from "../features/dialogue/api.js";
import {
  generateFlashcards,
  fetchFlashcards,
  updateFlashcard,
  deleteFlashcard,
} from "../features/flashcards/api.js";
import { flashcardsToMarkdown } from "../features/flashcards/markdown.js";
import { StateBar } from "../ui/bits.js";

type FlashState =
  | { kind: "running" }
  | { kind: "success"; count: number }
  | { kind: "error"; message: string }
  | null;

/**
 * Flashcards page (spec §4.8). Cards are appended from the session's full
 * dialogue (duplicates are allowed and the header says so honestly);
 * deletion is immediate, editing happens in a pre-filled modal.
 */
export function FlashcardsScreen({
  lessonId,
  onBackToLesson,
}: {
  lessonId: string;
  onBackToLesson: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cards, setCards] = useState<FlashcardDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [flashState, setFlashState] = useState<FlashState>(null);
  const [editing, setEditing] = useState<FlashcardDto | null>(null);
  const [editQuestion, setEditQuestion] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // createSession is idempotent per lesson (server reuses the
        // existing session), so the page works after a refresh too.
        const session = await createSession(lessonId);
        const list = await fetchFlashcards(session.id);
        if (cancelled) return;
        setSessionId(session.id);
        setCards(list);
      } catch (err) {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lessonId]);

  const handleGenerate = async () => {
    if (!sessionId || generating) return;
    setGenerating(true);
    setFlashState({ kind: "running" });
    try {
      const result = await generateFlashcards(sessionId);
      setCards((prev) => [...prev, ...result.flashcards]);
      setFlashState({ kind: "success", count: result.flashcards.length });
    } catch (err) {
      setFlashState({
        kind: "error",
        message:
          err instanceof Error
            ? `生成失败：${err.message}`
            : "生成失败：请稍后重试。",
      });
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      const updated = await updateFlashcard(editing.id, {
        question: editQuestion,
      });
      setCards((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setEditing(null);
    } catch (err) {
      setEditError(
        err instanceof Error ? `保存失败：${err.message}` : "保存失败：请重试。",
      );
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async (card: FlashcardDto) => {
    try {
      await deleteFlashcard(card.id);
      setCards((prev) => prev.filter((c) => c.id !== card.id));
      setFlashState(null);
    } catch (err) {
      setFlashState({
        kind: "error",
        message:
          err instanceof Error ? `删除失败：${err.message}` : "删除失败：请重试。",
      });
    }
  };

  const handleExport = () => {
    const markdown = flashcardsToMarkdown(cards);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "flashcards.md";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="screen active" data-od-id="flashcards-page">
      <button type="button" className="back" onClick={onBackToLesson}>
        返回课堂
      </button>
      <div className="page-head" style={{ marginTop: 24 }}>
        <div>
          <p className="eyebrow">课堂闪卡</p>
          <h1 className="page-title">把刚才想通的留下来</h1>
          <p className="lead">闪卡从当前完整课堂对话追加生成，可能与已有闪卡重复。</p>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="button"
            onClick={() => void handleGenerate()}
            disabled={generating || !sessionId}
            data-od-id="generate-cards"
          >
            从对话追加生成
          </button>
          <button
            type="button"
            className="button primary"
            onClick={handleExport}
            disabled={cards.length === 0}
            data-od-id="export-cards"
          >
            导出 Markdown
          </button>
        </div>
      </div>

      {flashState?.kind === "running" && (
        <StateBar odId="flash-state">正在从完整课堂对话追加生成闪卡…</StateBar>
      )}
      {flashState?.kind === "success" && (
        <StateBar variant="success" odId="flash-state">
          已追加 <span className="num">{flashState.count}</span>{" "}
          张闪卡。请检查是否有重复内容。
        </StateBar>
      )}
      {flashState?.kind === "error" && (
        <StateBar variant="error" odId="flash-state">
          {flashState.message}
        </StateBar>
      )}
      {loadError && (
        <StateBar variant="error" odId="flash-state">
          无法读取闪卡：{loadError}
        </StateBar>
      )}

      {loading ? (
        <StateBar odId="flash-loading">正在读取闪卡…</StateBar>
      ) : cards.length === 0 ? (
        <div className="empty" data-od-id="flashcards-empty">
          <h2>还没有闪卡。</h2>
          <p>从当前完整课堂对话追加生成第一批闪卡。</p>
        </div>
      ) : (
        <div className="flash-grid" data-od-id="flashcard-list">
          {cards.map((card) => (
            <article className="flashcard" key={card.id}>
              <p className="eyebrow">问题</p>
              <h3>{card.question}</h3>
              <p>
                <b>答案</b>：{card.answer}
              </p>
              {card.explanation && (
                <p>
                  <b>解释</b>：{card.explanation}
                </p>
              )}
              <div className="row-actions">
                <button
                  type="button"
                  className="back"
                  onClick={() => {
                    setEditError(null);
                    setEditing(card);
                    setEditQuestion(card.question);
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="back"
                  style={{ color: "var(--danger)" }}
                  onClick={() => void handleDelete(card)}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div
        className={editing ? "modal-layer open" : "modal-layer"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-card-title"
        data-od-id="edit-flashcard"
        ref={modalRef}
        onClick={(e) => {
          if (e.target === e.currentTarget && !savingEdit) setEditing(null);
        }}
      >
        <div className="modal">
          <p className="eyebrow">编辑闪卡</p>
          <h2 id="edit-card-title">编辑问题</h2>
          <div className="field">
            <label htmlFor="edit-question">问题</label>
            <input
              id="edit-question"
              value={editQuestion}
              onChange={(e) => setEditQuestion(e.target.value)}
            />
          </div>
          {editError && (
            <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
              {editError}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => setEditing(null)}
              disabled={savingEdit}
            >
              取消
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => void handleSaveEdit()}
              disabled={savingEdit || editQuestion.trim().length === 0}
            >
              {savingEdit ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
