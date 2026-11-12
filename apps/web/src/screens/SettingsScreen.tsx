import { useEffect, useState, type FormEvent } from "react";
import type { LlmSettingsResponse } from "@elenchi/shared";
import { fetchSettings, saveSettings, testConnection } from "../features/settings/api.js";
import { StateBar } from "../ui/bits.js";

/**
 * AI service settings page (spec §4.2). Test and save are independent
 * flows; both stay on this page with inputs preserved on failure.
 * A blank API Key means "keep the stored key" on the server (edit mode).
 */
export function SettingsScreen({
  onSaved,
  onBack,
}: {
  onSaved: () => void;
  onBack: () => void;
}) {
  const [settings, setSettings] = useState<LlmSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");

  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<
    { kind: "running" } | { kind: "success" } | { kind: "error"; message: string } | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    fetchSettings()
      .then((s) => {
        setSettings(s);
        setBaseUrl(s.baseUrl ?? "http://localhost:11434/v1");
        setModel(s.model ?? "qwen2.5:14b");
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  const isEdit = settings?.configured === true;
  const canTest = baseUrl.trim().length > 0 && apiKey.trim().length > 0;
  const canSave =
    baseUrl.trim().length > 0 &&
    model.trim().length > 0 &&
    (isEdit || apiKey.trim().length > 0);

  const handleTest = async () => {
    setTesting(true);
    setTestState({ kind: "running" });
    try {
      const result = await testConnection({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
      });
      setTestState(
        result.ok
          ? { kind: "success" }
          : { kind: "error", message: result.message },
      );
    } catch {
      setTestState({
        kind: "error",
        message: "测试失败：无法连接到该 AI 服务。请检查 Base URL、API Key 和模型名称后重试。",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      const trimmedKey = apiKey.trim();
      await saveSettings(
        isEdit && trimmedKey.length === 0
          ? { baseUrl: baseUrl.trim(), model: model.trim() }
          : { baseUrl: baseUrl.trim(), apiKey: trimmedKey, model: model.trim() },
      );
      onSaved();
    } catch {
      setSaveError("保存失败：无法写入这台设备的连接设置。请检查服务地址后重试。");
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <section className="screen active" data-od-id="ai-settings-page">
        <button type="button" className="back" onClick={onBack}>
          返回教材库
        </button>
        <StateBar variant="error" odId="settings-load-state">
          <span>无法读取连接设置：{loadError}</span>
          <button type="button" className="button" onClick={onBack}>
            返回教材库
          </button>
        </StateBar>
      </section>
    );
  }

  return (
    <section className="screen active" data-od-id="ai-settings-page">
      <button type="button" className="back" onClick={onBack}>
        返回教材库
      </button>
      <div className="page-head" style={{ marginTop: 25 }}>
        <div>
          <p className="eyebrow">AI 服务</p>
          <h1 className="page-title">配置你的 AI 伙伴</h1>
          <p className="lead">
            连接兼容 OpenAI API 的服务，用它来为教材备课并在课堂中追问。
          </p>
        </div>
      </div>

      <div className="panel narrow">
        <div className="tabs">
          <button type="button" className="tab active">连接设置</button>
        </div>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave && !saving) void handleSave(e);
          }}
        >
          <div className="field" id="url-field">
            <label htmlFor="base-url">Base URL</label>
            <input
              id="base-url"
              placeholder="http://localhost:11434/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="api-key">API Key</label>
            <input
              id="api-key"
              type="password"
              placeholder={isEdit ? "留空以继续使用现有密钥" : "sk-…"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required={!isEdit}
            />
            <p className="form-note">测试新连接时需要重新输入 API Key。</p>
          </div>
          <div className="field">
            <label htmlFor="model">模型名称</label>
            <input
              id="model"
              placeholder="qwen2.5:14b"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
            />
          </div>
          <p className="form-note">连接设置保存在这台设备的 Elenchi 数据目录中。</p>

          {testState?.kind === "running" && (
            <StateBar odId="test-state">正在测试连接…</StateBar>
          )}
          {testState?.kind === "success" && (
            <StateBar variant="success" odId="test-state">
              连接成功。模型可以用于备课和课堂追问。
            </StateBar>
          )}
          {testState?.kind === "error" && (
            <StateBar variant="error" odId="test-state">
              {testState.message}
            </StateBar>
          )}
          {saveError && (
            <StateBar variant="error" odId="save-state" >
              {saveError}
            </StateBar>
          )}

          <div className="actions">
            <button
              id="test-button"
              type="button"
              className="button"
              onClick={() => void handleTest()}
              disabled={testing || !canTest}
              title={isEdit && apiKey.length === 0 ? "测试前请先输入 API Key" : undefined}
            >
              测试连接
            </button>
            <button
              id="save-button"
              type="submit"
              className="button primary"
              disabled={saving || !canSave}
            >
              {saving ? "保存中…" : "保存并继续"}
            </button>
            <button type="button" className="button" onClick={onBack}>
              取消
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
