import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Connection page (spec §4.1): three mutually exclusive blocks driven by a
 * real /api/health probe. Auto-probes on mount; "重新连接" returns to the
 * connecting state and probes again.
 */
export function ConnectScreen({
  onContinue,
}: {
  onContinue: () => void;
}) {
  const [phase, setPhase] = useState<"connecting" | "success" | "failed">(
    "connecting",
  );
  const [detail, setDetail] = useState<string | null>(null);
  const attemptRef = useRef(0);

  const probe = useCallback(() => {
    const attempt = ++attemptRef.current;
    setPhase("connecting");
    setDetail(null);
    fetch("/api/health")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ version?: string }>;
      })
      .then(() => {
        if (attemptRef.current === attempt) setPhase("success");
      })
      .catch((err: unknown) => {
        if (attemptRef.current !== attempt) return;
        setDetail(err instanceof Error ? err.message : String(err));
        setPhase("failed");
      });
  }, []);

  useEffect(probe, [probe]);

  if (phase === "connecting") {
    return (
      <section id="connect" className="screen connection active" data-od-id="connection-page">
        <div id="connecting">
          <div className="spinner" aria-hidden="true" />
          <h1 className="page-title">正在连接你的本地学习桌…</h1>
          <p className="lead">Elenchi 正在查找这台设备上运行的服务。</p>
        </div>
      </section>
    );
  }

  if (phase === "success") {
    return (
      <section id="connect" className="screen connection active" data-od-id="connection-page">
        <div className="panel narrow" role="status" data-od-id="connect-success">
          <p className="eyebrow">本地服务</p>
          <div
            aria-hidden="true"
            style={{
              width: 38, height: 38, border: "1px solid var(--accent)",
              borderRadius: "50%", display: "grid", placeItems: "center",
              color: "var(--accent)", fontSize: 20, marginBottom: 18,
            }}
          >
            ✓
          </div>
          <h1 className="page-title" style={{ marginTop: 0 }}>
            已连接到你的本地学习桌。
          </h1>
          <p className="lead">
            服务正在这台设备上运行。接下来配置 AI 服务，即可导入教材并开始课堂。
          </p>
          <div className="actions">
            <button type="button" className="button primary" onClick={onContinue}>
              配置 AI 服务
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id="connect" className="screen connection active" data-od-id="connection-page">
      <div className="panel narrow" data-od-id="connect-failed">
        <p className="eyebrow">本地服务</p>
        <h1 className="page-title" style={{ marginTop: 0 }}>
          无法连接本地 Elenchi 服务。
        </h1>
        <p className="lead">请确认 Elenchi 仍在运行，然后重试。</p>
        <div className="actions">
          <button type="button" className="button primary" onClick={probe}>
            重新连接
          </button>
        </div>
        <details style={{ marginTop: 20 }}>
          <summary>技术详情</summary>
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            {detail ?? "连接地址不可用。此状态不会影响你的本地教材文件。"}
          </p>
        </details>
      </div>
    </section>
  );
}
