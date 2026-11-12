import { useCallback, useEffect, useState } from "react";
import type { LessonDto, MaterialSummary } from "@elenchi/shared";
import { ConnectScreen } from "./screens/ConnectScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { LibraryScreen } from "./screens/LibraryScreen.js";
import { ChaptersScreen } from "./screens/ChaptersScreen.js";
import { CoursesScreen } from "./screens/CoursesScreen.js";
import { LessonScreen } from "./screens/LessonScreen.js";
import { CompleteScreen } from "./screens/CompleteScreen.js";
import { FlashcardsScreen } from "./screens/FlashcardsScreen.js";
import { RecordScreen } from "./screens/RecordScreen.js";

/**
 * Screen ids mirror the prototype's `go(id)` contract (spec §2): exactly one
 * active screen, `localStorage('elenchi-screen')` for restore, scroll to top
 * on every switch. Navigation context (book/chapter/lesson ids) lives in a
 * separate key so a restored page can refetch its own data.
 */
const SCREENS = [
  "connect",
  "settings",
  "library",
  "chapters",
  "courses",
  "lesson",
  "complete",
  "flashcards",
  "record",
] as const;
type ScreenId = (typeof SCREENS)[number];

interface NavContext {
  materialId?: string;
  materialTitle?: string;
  chunkId?: string;
  chunkTitle?: string;
  lessonId?: string;
  sessionId?: string;
}

const SCREEN_KEY = "elenchi-screen";
const CONTEXT_KEY = "elenchi-context";

/** Screens that need at least the material id to make sense after restore. */
const CONTEXT_REQUIRED: Partial<Record<ScreenId, (keyof NavContext)[]>> = {
  chapters: ["materialId"],
  courses: ["chunkId"],
  lesson: ["chunkId", "lessonId"],
  complete: ["chunkId", "lessonId"],
  flashcards: ["lessonId"],
  record: ["chunkId", "lessonId"],
};

function readContext(): NavContext {
  try {
    const raw = localStorage.getItem(CONTEXT_KEY);
    return raw ? (JSON.parse(raw) as NavContext) : {};
  } catch {
    return {};
  }
}

export function App() {
  const [screen, setScreen] = useState<ScreenId>("connect");
  const [ctx, setCtx] = useState<NavContext>({});
  // Once the user has left the connect flow it must never appear again —
  // not via the brand button, not via state restore (spec §2/§4.1).
  const [connectDone, setConnectDone] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(SCREEN_KEY) as ScreenId | null;
    if (saved && saved !== "connect" && SCREENS.includes(saved)) {
      const missing = (CONTEXT_REQUIRED[saved] ?? []).some(
        (key) => readContext()[key] === undefined,
      );
      setConnectDone(true);
      setScreen(missing ? "library" : saved);
      setCtx(missing ? {} : readContext());
    } else {
      setScreen("connect");
    }
  }, []);

  const go = useCallback((next: ScreenId, nextCtx?: NavContext) => {
    if (next === "connect") return; // the connect page is one-shot
    setConnectDone(true);
    setCtx((prev) => {
      const merged = { ...prev, ...nextCtx };
      localStorage.setItem(CONTEXT_KEY, JSON.stringify(merged));
      return merged;
    });
    setScreen(next);
    localStorage.setItem(SCREEN_KEY, next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const openLibrary = useCallback(() => go("library"), [go]);

  return (
    <div className="app" data-od-id="elenchi-app">
      <header className="topbar" data-od-id="topbar">
        <button
          type="button"
          className="brand"
          data-od-id="brand-logo"
          aria-label="返回教材库"
          onClick={openLibrary}
        >
          <svg
            aria-hidden="true"
            width="30"
            height="30"
            viewBox="0 0 30 30"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M22.7 8.1C20.8 5.9 17.9 4.5 14.7 4.5C8.9 4.5 4.2 8.7 4.2 14.3C4.2 19.8 8.5 24 14.1 24C18.8 24 22.8 20.9 24.1 16.7"
              stroke="var(--accent)"
              strokeWidth="2.1"
              strokeLinecap="round"
            />
            <path
              d="M24.1 16.7C25.1 13.3 23.9 9.8 21 7.6"
              stroke="var(--fg)"
              strokeWidth="2.1"
              strokeLinecap="round"
            />
            <circle cx="24.2" cy="16.7" r="2" fill="var(--accent)" />
          </svg>
          <span className="brand-wordmark">
            Elench<i>i</i>
          </span>
        </button>
        <div className="top-actions">
          <button type="button" className="button" onClick={openLibrary}>
            教材库
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="AI 服务设置"
            onClick={() => go("settings")}
          >
            ⚙
          </button>
        </div>
      </header>

      {/* Exactly one active screen at a time. */}
      {!connectDone && screen === "connect" && (
        <ConnectScreen onContinue={() => go("settings")} />
      )}

      {screen === "settings" && (
        <SettingsScreen
          onSaved={() => go("library")}
          onBack={openLibrary}
        />
      )}

      {screen === "library" && (
        <LibraryScreen
          onOpenBook={(material: MaterialSummary) =>
            go("chapters", { materialId: material.id, materialTitle: material.title })
          }
          onOpenSettings={() => go("settings")}
        />
      )}

      {screen === "chapters" && ctx.materialId && (
        <ChaptersScreen
          materialId={ctx.materialId}
          materialTitle={ctx.materialTitle ?? "我的教材"}
          onOpenChapter={(chunk) =>
            go("courses", { chunkId: chunk.id, chunkTitle: chunk.title })
          }
          onBack={openLibrary}
        />
      )}

      {screen === "courses" && ctx.chunkId && (
        <CoursesScreen
          materialTitle={ctx.materialTitle ?? "我的教材"}
          chunkId={ctx.chunkId}
          chunkTitle={ctx.chunkTitle ?? ""}
          onEnterLesson={(lesson: LessonDto) =>
            go("lesson", { lessonId: lesson.id })
          }
          onBackToLibrary={openLibrary}
          onBackToChapters={() => go("chapters")}
        />
      )}

      {screen === "lesson" && ctx.chunkId && ctx.lessonId && (
        <LessonScreen
          chunkId={ctx.chunkId}
          lessonId={ctx.lessonId}
          onSessionKnown={(sessionId) =>
            setCtx((prev) => {
              const merged = { ...prev, sessionId };
              localStorage.setItem(CONTEXT_KEY, JSON.stringify(merged));
              return merged;
            })
          }
          onCompleted={() => go("complete")}
          onExit={() => go("courses")}
        />
      )}

      {screen === "complete" && ctx.chunkId && ctx.lessonId && (
        <CompleteScreen
          chunkId={ctx.chunkId}
          lessonId={ctx.lessonId}
          onOpenFlashcards={() => go("flashcards")}
          onOpenRecord={() => go("record")}
          onBackToCourses={() => go("courses")}
        />
      )}

      {screen === "flashcards" && ctx.lessonId && (
        <FlashcardsScreen
          lessonId={ctx.lessonId}
          onBackToLesson={() => go("lesson")}
        />
      )}

      {screen === "record" && ctx.chunkId && ctx.lessonId && (
        <RecordScreen
          chunkId={ctx.chunkId}
          lessonId={ctx.lessonId}
          onBackToLesson={() => go("lesson")}
        />
      )}
    </div>
  );
}
