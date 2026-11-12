import { useEffect, useState } from "react";
import type { LessonDto } from "@elenchi/shared";
import { fetchChunkLessons } from "../features/materials/api.js";
import { fetchLessonKps } from "../features/lessons/api.js";
import { KnowledgeRow, StateBar } from "../ui/bits.js";

/**
 * Lesson completion page (spec §4.7). Reached when the tutor closes the
 * lesson (all KPs mastered); lists the lesson's knowledge points with their
 * final mastery marks.
 */
export function CompleteScreen({
  chunkId,
  lessonId,
  onOpenFlashcards,
  onOpenRecord,
  onBackToCourses,
}: {
  chunkId: string;
  lessonId: string;
  onOpenFlashcards: () => void;
  onOpenRecord: () => void;
  onBackToCourses: () => void;
}) {
  const [lesson, setLesson] = useState<LessonDto | null>(null);
  const [kps, setKps] = useState<{ id: string; statement: string; mastered: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lessonsBody = await fetchChunkLessons(chunkId);
        const found = lessonsBody.lessons?.find((l) => l.id === lessonId) ?? null;
        const kpsBody = await fetchLessonKps(lessonId);
        if (cancelled) return;
        setLesson(found);
        setKps(kpsBody.kps);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chunkId, lessonId]);

  if (error) {
    return (
      <section className="screen active" data-od-id="lesson-complete-page">
        <StateBar variant="error" odId="complete-error">
          <span>无法读取课程完成信息：{error}</span>
          <button type="button" className="button" onClick={onBackToCourses}>
            返回课程列表
          </button>
        </StateBar>
      </section>
    );
  }

  const kpCount = lesson?.kpCount ?? kps.length;
  const masteredCount = lesson?.masteredKpCount ?? kps.filter((k) => k.mastered).length;
  const allDone = kpCount > 0 && masteredCount >= kpCount;

  return (
    <section className="screen active" data-od-id="lesson-complete-page">
      <div className="narrow-wrap">
        <p className="eyebrow">课程完成</p>
        <h1 className="title">这一次，你把因果关系说清楚了。</h1>
        <p className="lead">
          本课的 <span className="num">{kpCount}</span> 个知识点
          {allDone ? "已全部掌握" : `已掌握 ${masteredCount} 个`}。
          现在可以把课堂对话整理为闪卡，或回到课程列表查看这一章的进度。
        </p>

        <div className="panel mastery-panel" style={{ marginTop: 32 }} data-od-id="mastery-panel">
          <span className="meta">本课掌握</span>
          {kps.map((kp) => (
            <KnowledgeRow key={kp.id} statement={kp.statement} done={kp.mastered} />
          ))}
        </div>

        <div className="actions">
          <button type="button" className="button primary" onClick={onOpenFlashcards}>
            整理为闪卡
          </button>
          <button type="button" className="button" onClick={onOpenRecord}>
            查看课堂实录
          </button>
          <button type="button" className="button" onClick={onBackToCourses}>
            返回课程列表
          </button>
        </div>
      </div>
    </section>
  );
}
