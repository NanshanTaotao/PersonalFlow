import { useState } from "react";

import type { ApiClient } from "../api/client";
import type { ApiFailure, SceneView } from "../api/types";

interface ImportExportPageProps {
  readonly scene: SceneView | null;
  readonly api: ApiClient;
  readonly onImported: (scene: SceneView) => void;
  readonly onGoToScene: () => void;
  readonly onError: (error: ApiFailure) => void;
}

const productError = (message: string): ApiFailure => ({ code: "import_export_error", message });

const stableIdempotencyKey = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return `import-${Math.abs(hash)}`;
};

const formatExportJson = (value: unknown) => {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return JSON.stringify(parsed, null, 2);
  }
  return JSON.stringify(value, null, 2);
};

export function ImportExportPage({ scene, api, onImported, onGoToScene, onError }: ImportExportPageProps) {
  const [exportText, setExportText] = useState("");
  const [importText, setImportText] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<ApiFailure | null>(null);
  const [importedScene, setImportedScene] = useState<SceneView | null>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);

  const showError = (next: ApiFailure) => {
    setError(next);
    setMessage("");
    onError(next);
  };

  const exportCurrentScene = async () => {
    if (scene === null) {
      return;
    }
    setBusy("export");
    setError(null);
    const result = await api.exportScene(scene.id);
    setBusy(null);
    if (!result.ok || result.data === undefined) {
      showError(result.error ?? productError("导出失败，请稍后重试。"));
      return;
    }
    try {
      setExportText(formatExportJson(result.data.export_json));
      setMessage("导出成功，可以复制保存。");
    } catch {
      showError(productError("导出结果暂时无法显示，请重试。"));
    }
  };

  const importScene = async () => {
    if (importText.trim() === "") {
      showError(productError("请先粘贴场景文件内容。"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      showError(productError("JSON 格式不正确，请检查后重试。"));
      return;
    }
    setBusy("import");
    setError(null);
    const result = await api.importScene(parsed, stableIdempotencyKey(importText));
    setBusy(null);
    if (!result.ok || result.data === undefined) {
      showError(result.error ?? productError("导入失败，请检查场景文件后重试。"));
      return;
    }
    setImportedScene(result.data.scene);
    onImported(result.data.scene);
    setMessage("导入成功，可以进入场景确认。");
  };

  return (
    <section className="import-export-page">
      <header className="import-export-hero">
        <div>
          <p className="eyebrow">场景迁移</p>
          <h2>场景导入导出</h2>
          <p>这是高级能力，适合迁移或分享已确认场景。这是场景文件，不是普通编辑区；日常创建和演练不需要编辑 JSON。</p>
          <p>这里导入导出的是单个场景文件，不是完整工作区备份。</p>
        </div>
      </header>

      <div className="import-export-grid">
        <section aria-label="导出场景" className="import-export-card">
          <h3>导出当前场景</h3>
          {scene === null ? (
            <p>先创建并确认一个场景后再导出。</p>
          ) : (
            <>
              <p>当前可导出：{scene.title}</p>
              <button type="button" className="secondary-action" onClick={exportCurrentScene} disabled={busy === "export"}>{busy === "export" ? "正在导出..." : "导出当前场景"}</button>
            </>
          )}
          <label className="form-field">
            <span>导出的场景文件</span>
            <textarea aria-label="导出的场景文件" readOnly value={exportText} rows={12} />
          </label>
        </section>

        <section aria-label="导入场景" className="import-export-card">
          <h3>导入新场景</h3>
          <label className="form-field">
            <span>粘贴场景文件</span>
            <textarea aria-label="粘贴场景文件" value={importText} onChange={(event) => setImportText(event.target.value)} rows={12} />
          </label>
          <button type="button" className="primary-action" onClick={importScene} disabled={busy === "import"}>{busy === "import" ? "正在导入..." : "导入场景"}</button>
        </section>
      </div>

      {message === "" ? null : <p role="status">{message}</p>}
      {error === null ? null : <p role="alert">{error.message}</p>}
      {importedScene === null ? null : (
        <section aria-label="导入结果" className="import-export-result">
          <h3>导入成功</h3>
          <p>{importedScene.title}</p>
          <button type="button" onClick={onGoToScene}>进入场景确认</button>
        </section>
      )}
    </section>
  );
}
