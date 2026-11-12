import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { MaterialSummary } from "@elenchi/shared";
import { fetchMaterials, uploadMaterial, deleteMaterial } from "../features/materials/api.js";
import { StateBar } from "../ui/bits.js";

/**
 * Library home (spec §4.3). Import via a real file upload; deletion goes
 * through the global confirm modal before hitting the API. The card shows
 * title + chapter count (recent-study position has no backend data source,
 * see conversation decision 2026-09-15: the field is omitted).
 */
export function LibraryScreen({
  onOpenBook,
  onOpenSettings,
}: {
  onOpenBook: (material: MaterialSummary) => void;
  onOpenSettings: () => void;
}) {
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importState, setImportState] = useState<
    { kind: "running"; name: string } | { kind: "success"; name: string } | { kind: "error"; message: string } | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<MaterialSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteState, setDeleteState] = useState<
    { kind: "running" } | { kind: "success" } | { kind: "error"; message: string } | null
  >(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => {
    setListError(null);
    fetchMaterials()
      .then(setMaterials)
      .catch((err: unknown) =>
        setListError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  };

  useEffect(reload, []);

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    setImportState({ kind: "running", name: file.name });
    try {
      await uploadMaterial(file);
      setImportState({ kind: "success", name: file.name });
      reload();
    } catch (err) {
      setImportState({
        kind: "error",
        message:
          err instanceof Error
            ? `导入失败：${err.message}`
            : "导入失败：无法读取该文件。请确认是 .md 文件后重试。",
      });
    } finally {
      setImporting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteState({ kind: "running" });
    try {
      await deleteMaterial(deleteTarget.id);
      setDeleteTarget(null);
      setDeleteState({ kind: "success" });
      reload();
    } catch (err) {
      setDeleteState({
        kind: "error",
        message:
          err instanceof Error
            ? `删除失败：${err.message}`
            : "删除失败：请重试。",
      });
    } finally {
      setDeleting(false);
    }
  };

  const importedTitle =
    importState && "name" in importState
      ? importState.name.replace(/\.md$/i, "")
      : "";

  return (
    <section className="screen active" data-od-id="library-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">教材库</p>
          <h1 className="page-title" style={{ fontWeight: 400 }}>我的教材</h1>
          <p className="lead">导入一个 Markdown 文件，Elenchi 会按章节整理并准备课程。</p>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={() => fileRef.current?.click()}
          disabled={importing}
          data-od-id="import-trigger"
        >
          导入 Markdown 教材
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".md"
          hidden
          onChange={(e) => void handleImport(e)}
        />
      </div>

      {importState?.kind === "running" && (
        <StateBar odId="import-state">正在导入 Markdown 教材…</StateBar>
      )}
      {importState?.kind === "success" && (
        <StateBar variant="success" odId="import-state">
          已导入《{importedTitle}》。章节正在整理中。
        </StateBar>
      )}
      {importState?.kind === "error" && (
        <StateBar variant="error" odId="import-state">
          {importState.message}
        </StateBar>
      )}
      {deleteState?.kind === "running" && (
        <StateBar odId="delete-state">正在删除教材…</StateBar>
      )}
      {deleteState?.kind === "success" && (
        <StateBar variant="success" odId="delete-state">
          教材已删除。此操作无法恢复。
        </StateBar>
      )}
      {deleteState?.kind === "error" && (
        <StateBar variant="error" odId="delete-state">
          {deleteState.message}
        </StateBar>
      )}

      {loading ? (
        <StateBar odId="library-loading">正在读取教材列表…</StateBar>
      ) : listError ? (
        <StateBar variant="error" odId="library-error">
          <span>无法读取教材列表：{listError}</span>
          <button type="button" className="button" onClick={reload}>
            重新读取
          </button>
        </StateBar>
      ) : materials.length === 0 ? (
        <div className="empty" data-od-id="library-empty">
          <h2>还没有教材。</h2>
          <p>从一份 Markdown 教材开始，建立你的第一张学习桌。</p>
        </div>
      ) : (
        <div className="library-list" data-od-id="book-list">
          {materials.map((m) => (
            <article className="book-card" key={m.id}>
              <div>
                <h3>《{m.title}》</h3>
                <p>
                  <span className="num">{m.chunkCount}</span> 个章节
                </p>
              </div>
              <div className="row-actions">
                <button type="button" className="button" onClick={() => onOpenBook(m)}>
                  进入教材
                </button>
                <button
                  type="button"
                  className="button danger"
                  onClick={() => {
                    setDeleteState(null);
                    setDeleteTarget(m);
                  }}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="row-actions" style={{ marginTop: 35 }}>
        <button type="button" className="back" onClick={onOpenSettings}>
          更改 AI 服务设置
        </button>
      </div>

      <div
        className={deleteTarget ? "modal-layer open" : "modal-layer"}
        id="delete-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-modal-title"
        data-od-id="delete-confirmation"
        onClick={(e) => {
          if (e.target === e.currentTarget && !deleting) setDeleteTarget(null);
        }}
      >
        <div className="modal">
          <p className="eyebrow">删除教材</p>
          <h2 id="delete-modal-title">删除《{deleteTarget?.title ?? ""}》？</h2>
          <p>
            它的 {deleteTarget?.chunkCount ?? 0} 个章节、课程准备结果、课堂记录和闪卡都会一并删除，且无法恢复。
          </p>
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              取消
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => void handleConfirmDelete()}
              disabled={deleting}
            >
              {deleting ? "删除中…" : "删除教材"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
