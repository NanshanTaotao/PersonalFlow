import { useState } from "react";

import type { ApiClient } from "../api/client";
import type { ApiFailure, MaterialSummaryView } from "../api/types";

interface MaterialsPageProps {
  readonly materials: readonly MaterialSummaryView[];
  readonly status: "loading" | "ready" | "failed";
  readonly message: string;
  readonly api: ApiClient;
  readonly onMaterialsChanged: (materials: MaterialSummaryView[], message: string) => void;
  readonly onError: (error: ApiFailure) => void;
}

export function MaterialsPage({ materials, status, message, api, onMaterialsChanged, onError }: MaterialsPageProps) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const result = await api.createMaterial({ title, text, source: "manual", idempotency_key: `material-${Date.now()}` });
    if (!result.ok || result.data === undefined) {
      onError(result.error ?? { code: "api_error", message: "材料保存失败，请删减后重试。" });
      return;
    }
    setTitle("");
    setText("");
    onMaterialsChanged([result.data.material, ...materials], "材料已保存，可在场景确认页引用。");
  };

  return (
    <section className="materials-page">
      <header className="materials-hero">
        <div>
          <p className="eyebrow">材料管理</p>
          <h2>我的材料</h2>
          <p>管理可复用文本材料。保存后，可在每个场景的开始前确认页引用。</p>
        </div>
      </header>
      <div className="materials-layout">
        <form className="materials-card materials-form-card" onSubmit={submit}>
          <h3>新增材料到材料库</h3>
          <label className="form-field">
            <span>材料名称</span>
            <input value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
          </label>
          <label className="form-field">
            <span>材料正文</span>
            <textarea value={text} onChange={(event) => setText(event.currentTarget.value)} />
          </label>
          <button type="submit" className="primary-action" disabled={title.trim().length === 0 || text.trim().length === 0}>保存到材料库</button>
        </form>
        <section aria-label="材料列表" className="materials-card materials-list-card">
          <h3>材料库</h3>
          {materials.length === 0 ? <p>还没有可复用材料。你也可以在具体场景中添加临时文本材料。</p> : (
            <ul className="materials-list">
              {materials.map((material) => (
                <li key={material.id}>
                  <div>
                    <strong>{material.title}</strong>
                    <span>{material.source_label}</span>
                  </div>
                  <p>{material.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {message === "" ? null : <p aria-live="polite">{message}</p>}
      {status === "loading" ? <p>正在读取材料...</p> : null}
      {status === "failed" ? <p role="alert">材料读取失败，请刷新后重试。</p> : null}
    </section>
  );
}
