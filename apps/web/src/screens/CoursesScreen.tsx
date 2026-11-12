import { useCallback, useEffect, useState } from "react";
import type { LessonDto } from "@elenchi/shared";
import { cancelQualityPrep, createQualityPrep, fetchChunkLessons, getQualityPrepTask, getQualityPrepTaskForChunk, resumeQualityPrep, startQualityPrep, type QualityPrepTask } from "../features/materials/api.js";
import { StateBar } from "../ui/bits.js";

type CourseUiState =
  | { kind: "loading" }
  | { kind: "preparing" }
  | { kind: "quality"; task: QualityPrepTask }
  | { kind: "ready"; lessons: LessonDto[]; partialSections: number }
  | { kind: "zero"; lessons: LessonDto[]; partialSections: number }
  | { kind: "prepFailed"; error: string }
  | { kind: "readFailed"; error: string };

/**
 * Course list of one chapter (spec §4.5). Quality prep is explicit: creating
 * a task does not call the model; start/resume is the paid execution boundary.
 * Every failure state stays on this page with its own retry action (spec §5).
 */
export function CoursesScreen({
  materialTitle,
  chunkId,
  chunkTitle,
  onEnterLesson,
  onBackToLibrary,
  onBackToChapters,
}: {
  materialTitle: string;
  chunkId: string;
  chunkTitle: string;
  onEnterLesson: (lesson: LessonDto) => void;
  onBackToLibrary: () => void;
  onBackToChapters: () => void;
}) {
  const [state, setState] = useState<CourseUiState>({ kind: "loading" });

  const loadQualityTask = useCallback(async (taskId: string) => {
    const task = await getQualityPrepTask(taskId);
    if (task.status === "succeeded") {
      const refreshed = await fetchChunkLessons(chunkId);
      const lessons = refreshed.lessons ?? [];
      const partialSections = refreshed.partialSections ?? 0;
      setState(lessons.length === 0 ? { kind: "zero", lessons, partialSections } : { kind: "ready", lessons, partialSections });
    } else if (task.status === "failed" || task.status === "cancelled") {
      setState({ kind: "prepFailed", error: task.reason ?? `质量备课${task.status === "cancelled" ? "已取消" : "失败"}` });
    } else setState({ kind: "quality", task });
    return task;
  }, [chunkId]);
  const runPrepare = useCallback(async () => {
    setState({ kind: "preparing" });
    try {
      const created = await createQualityPrep(chunkId);
      await loadQualityTask(created.taskId);
    } catch (err) { setState({ kind: "prepFailed", error: err instanceof Error ? err.message : String(err) }); }
  }, [chunkId, loadQualityTask]);
  const startTask = useCallback(async (task: QualityPrepTask) => {
    try {
      await (task.status === "paused" ? resumeQualityPrep(task.taskId) : startQualityPrep(task.taskId));
      await loadQualityTask(task.taskId);
      const refresh = window.setInterval(async () => {
        try { const current = await loadQualityTask(task.taskId); if (["succeeded", "failed", "cancelled"].includes(current.status)) window.clearInterval(refresh); }
        catch { /* keep the task panel visible; the next poll may recover */ }
      }, 1000);
      window.setTimeout(() => window.clearInterval(refresh), 180000);
    } catch (err) { setState({ kind: "prepFailed", error: err instanceof Error ? err.message : String(err) }); }
  }, [loadQualityTask]);
  const cancelTask = useCallback(async (taskId: string) => { await cancelQualityPrep(taskId); await loadQualityTask(taskId); }, [loadQualityTask]);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const body = await fetchChunkLessons(chunkId);
      if (body.status === "ready" && body.lessons) {
        const lessons = body.lessons;
        const partialSections = body.partialSections ?? 0;
        setState(
          lessons.length === 0
            ? { kind: "zero", lessons, partialSections }
            : { kind: "ready", lessons, partialSections },
        );
        return;
      }
      if (body.status === "failed") {
        setState({ kind: "prepFailed", error: body.error ?? "备课失败" });
        return;
      }
      const task = await getQualityPrepTaskForChunk(chunkId);
      if (task) { await loadQualityTask(task.taskId); return; }
      setState({ kind: "prepFailed", error: "尚未创建质量备课任务，请点击“创建质量备课任务”。" });
    } catch (err) {
      setState({
        kind: "readFailed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [chunkId, runPrepare]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="screen active" data-od-id="courses-page">
      <div className="breadcrumb">
        <button type="button" onClick={onBackToLibrary}>我的教材</button>
        {" / "}
        <button type="button" onClick={onBackToChapters}>{materialTitle}</button>
        {" / "}
        {chunkTitle}
      </div>
      <div className="page-head">
        <div>
          <p className="eyebrow">本章课程</p>
          <h1 className="page-title">{chunkTitle}</h1>
          <p className="lead">课程按知识点与认知容量编排为固定顺序的课堂。</p>
        </div>
        <button
          type="button"
          className="button"
          onClick={() => void runPrepare()}
          data-od-id="reprepare-trigger"
        >
          重新备课
        </button>
      </div>

      {state.kind === "loading" && (
        <StateBar odId="course-state">正在读取课程…</StateBar>
      )}
      {state.kind === "preparing" && <StateBar odId="course-state">正在创建质量备课任务，不会调用模型…</StateBar>}
      {state.kind === "quality" && (
        <StateBar odId="course-state">
          <span>质量备课：{state.task.status}，检查点 {state.task.checkpointCount}，调用 {state.task.callsUsed}，tokens {state.task.tokensUsed}</span>
          {(state.task.status === "queued" || state.task.status === "paused") && <button type="button" className="button" onClick={() => void startTask(state.task)}>{state.task.status === "paused" ? "恢复备课" : "开始备课"}</button>}
          {(state.task.status === "queued" || state.task.status === "running" || state.task.status === "paused") && <button type="button" className="button" onClick={() => void cancelTask(state.task.taskId)}>取消</button>}
        </StateBar>
      )}
      {state.kind === "prepFailed" && (
        <StateBar variant="error" odId="course-state">
          <span>备课失败：AI 服务暂时没有返回可用课程。({state.error})</span>
          <button type="button" className="button" onClick={() => void runPrepare()}>
            重试备课
          </button>
        </StateBar>
      )}
      {state.kind === "readFailed" && (
        <StateBar variant="error" odId="course-state">
          <span>无法读取章节课程：本地记录无法读取。({state.error})</span>
          <button type="button" className="button" onClick={() => void load()}>
            重新读取
          </button>
        </StateBar>
      )}
      {state.kind === "zero" && (
        <StateBar odId="course-state">
          <span>章节已完成备课，但没有生成课程。</span>
          <button type="button" className="button" onClick={() => void runPrepare()}>
            创建质量备课任务
          </button>
        </StateBar>
      )}

      {state.kind === "ready" && (
        <>
          {state.partialSections > 0 && (
            <StateBar variant="coverage" odId="coverage-state">
              有 <span className="num">{state.partialSections}</span>{" "}
              个小节未能完全确认知识点覆盖。建议阅读原文对照学习。
            </StateBar>
          )}
          <div className="course-list" data-od-id="course-list">
            {state.lessons.map((lesson) => {
              const completed = lesson.status === "completed";
              const locked = lesson.locked;
              const inProgress = !completed && lesson.masteredKpCount > 0;
              return (
                <article className="course-card" key={lesson.id}>
                  <span className="course-num">第 {lesson.order} 课</span>
                  <div>
                    <h3>{lesson.title}</h3>
                    <p>{lesson.objective}</p>
                    <div className="lesson-meta">
                      {completed && <span className="badge done">已完成</span>}
                      {inProgress && <span className="badge progress">进行中</span>}
                      {locked && <span className="badge locked">🔒 未解锁</span>}
                       {lesson.cardVersion ? <span className="badge published" title={`教学卡版本 ${lesson.cardVersion}`}>已验收教学卡</span> : <span className="badge checking">教学卡待验收</span>}
                      <span className="mastery">
                        已掌握 <span className="num">{lesson.masteredKpCount}</span> /{" "}
                        <span className="num">{lesson.kpCount}</span> 个知识点
                      </span>
                    </div>
                  </div>
                  {locked ? (
                    <button
                      type="button"
                      className="button"
                      disabled
                      title="先完成上一课，AI 才能结合上一轮学习情况为这堂课备课。"
                      data-od-id="lesson-locked"
                    >
                      先完成上一课
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={inProgress && !completed ? "button primary" : "button"}
                      onClick={() => onEnterLesson(lesson)}
                    >
                      {completed ? "查看课堂" : "进入课堂"}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
