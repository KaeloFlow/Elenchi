import { useCallback, useEffect, useState } from "react";
import type { MaterialChunkDto } from "@elenchi/shared";
import { fetchMaterialChunks } from "../features/materials/api.js";
import { StateBar } from "../ui/bits.js";

/** One-line chapter intro derived from the chunk's own content (no
 * backend summary field exists): the first non-heading paragraph, clamped. */
function chapterBrief(content: string): string {
  const paragraph = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!paragraph) return "";
  return paragraph.length > 64 ? `${paragraph.slice(0, 64)}…` : paragraph;
}

/**
 * Chapter list of one book (spec §4.4): numbered rows with a "查看课程"
 * entry; read-failure stays on-page with retry, empty book has its own state.
 */
export function ChaptersScreen({
  materialId,
  materialTitle,
  onOpenChapter,
  onBack,
}: {
  materialId: string;
  materialTitle: string;
  onOpenChapter: (chunk: { id: string; title: string }) => void;
  onBack: () => void;
}) {
  const [chunks, setChunks] = useState<MaterialChunkDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchMaterialChunks(materialId)
      .then(setChunks)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, [materialId]);

  useEffect(load, [load]);

  return (
    <section className="screen active" data-od-id="chapters-page">
      <div className="breadcrumb">
        <button type="button" onClick={onBack}>我的教材</button>
        {" / "}
        {materialTitle}
      </div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{materialTitle}</h1>
          <p className="lead">从任一章开始。Elenchi 会为进入的章节即时备课。</p>
        </div>
      </div>

      {loading && <StateBar odId="chapter-state">正在读取章节…</StateBar>}
      {error && (
        <StateBar variant="error" odId="chapter-state">
          <span>无法读取章节：本地文件暂时不可访问。({error})</span>
          <button type="button" className="button" onClick={load}>
            重新读取
          </button>
        </StateBar>
      )}
      {!loading && !error && chunks.length === 0 && (
        <div className="empty" data-od-id="chapter-empty">
          <h2>这本教材还没有章节。</h2>
          <p>回到教材库重新导入，或检查文件内容。</p>
        </div>
      )}
      {!loading && !error && chunks.length > 0 && (
        <div className="chapter-list" data-od-id="chapter-list">
          {chunks.map((chunk) => (
            <article className="chapter-row" key={chunk.id}>
              <span className="chapter-number num">
                {String(chunk.order).padStart(2, "0")}
              </span>
              <div>
                <h3>{chunk.title}</h3>
                <p>{chapterBrief(chunk.content)}</p>
              </div>
              <button
                type="button"
                className="button"
                onClick={() => onOpenChapter({ id: chunk.id, title: chunk.title })}
              >
                查看课程
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
