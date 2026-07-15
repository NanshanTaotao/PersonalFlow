import type { ApiClient } from "../api/client";
import type { ApiFailure, DraftView, JsonObject, JsonSchemaProperty, TemplateDetail, TemplateSummary } from "../api/types";

interface TemplatePageProps {
  readonly template: TemplateDetail | null;
  readonly templates?: readonly TemplateSummary[];
  readonly params: Record<string, string>;
  readonly onParamChange: (key: string, value: string) => void;
  readonly onSelectTemplate?: (templateId: string) => void;
  readonly api: ApiClient;
  readonly onDraftCreated: (draft: DraftView) => void;
  readonly onError: (error: ApiFailure) => void;
  readonly creationError?: ApiFailure | null;
}

const propertyLabel = (key: string, property: JsonSchemaProperty): string => property.label ?? property.title ?? property.description ?? key;
const isFixedNumericProperty = (property: JsonSchemaProperty): boolean =>
  (property.type === "integer" || property.type === "number") &&
  property.minimum !== undefined &&
  property.maximum !== undefined &&
  property.minimum === property.maximum;

const coerceParam = (property: JsonSchemaProperty, value: string) => {
  if (property.type === "integer" || property.type === "number") {
    return Number(value);
  }
  if (property.type === "boolean") {
    return value === "true";
  }
  return value;
};

export function TemplatePage({ template, templates = [], params, onParamChange, onSelectTemplate, api, onDraftCreated, onError, creationError = null }: TemplatePageProps) {
  if (template === null) {
    return (
      <section className="template-library-page">
        <header className="page-hero page-hero--compact">
          <div>
            <p className="eyebrow">演练模板</p>
            <h2>模板库</h2>
            <p>选择一个模板，进入开始前的演练简报配置。</p>
          </div>
        </header>
        <div className="template-library-grid">
          {templates.length === 0 ? (
            <article className="template-card">
              <h3>模板正在准备</h3>
              <p>模板列表读取完成后会显示可开始的真实演练场景。</p>
            </article>
          ) : templates.map((item) => (
            <article key={item.id} className="template-card">
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <button type="button" className="secondary-action" onClick={() => onSelectTemplate?.(item.id)}>开始演练</button>
            </article>
          ))}
        </div>
      </section>
    );
  }

  const properties = template.param_schema.properties ?? {};
  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const nextParams = Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, coerceParam(property, params[key] ?? String(template.default_params[key] ?? ""))])) as JsonObject;
    if (Object.values(nextParams).some((value) => typeof value === "number" && Number.isNaN(value))) {
      onError({ code: "validation_error", message: "模板参数中有数字格式不正确，请检查后再创建草稿。" });
      return;
    }
    const result = await api.createDraftFromTemplate({ template_id: template.id, params: nextParams, idempotency_key: `draft-${Date.now()}` });
    if (!result.ok || result.data === undefined) {
      onError(result.error ?? { code: "api_error", message: "草稿创建失败。" });
      return;
    }
    onDraftCreated(result.data.draft);
  };

  return (
    <section className="template-setup-page">
      <header className="page-hero page-hero--compact">
        <div>
          <p className="eyebrow">场景设置</p>
          <h2>完善演练简报</h2>
          <p>{template.description}</p>
        </div>
      </header>
      {creationError === null ? null : (
        <p role="alert"><strong>草稿创建失败</strong>：{creationError.message}</p>
      )}
      <div className="template-setup-grid">
        <form className="template-form-card" onSubmit={submit}>
          <h3>{template.title}</h3>
          <p>确认目标、建议轮次和追问重点后，系统会创建一份可检查的场景草稿。</p>
          {Object.entries(properties).map(([key, property]) => {
            const fixedNumeric = isFixedNumericProperty(property);
            return (
              <label key={key} className="form-field">
                <span>{propertyLabel(key, property)}</span>
                <input
                  value={params[key] ?? String(template.default_params[key] ?? property.default ?? "")}
                  onChange={(event) => onParamChange(key, event.currentTarget.value)}
                  readOnly={fixedNumeric}
                  aria-readonly={fixedNumeric}
                />
                {property.description === undefined ? null : <small className="form-field__hint">{property.description}</small>}
                {fixedNumeric ? <small className="form-field__hint">该模板为保证场景质量固定此轮次数。</small> : null}
              </label>
            );
          })}
          <button type="submit" className="primary-action">生成演练草稿</button>
        </form>
        <aside className="template-next-card" aria-label="下一步">
          <h3>下一步</h3>
          <p>草稿生成后会进入开始前确认页，你可以检查角色、流程和复盘维度，再决定是否开始演练。</p>
        </aside>
      </div>
    </section>
  );
}
