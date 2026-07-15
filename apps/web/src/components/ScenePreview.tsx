import type { DraftView, SceneView, TemplatePreview } from "../api/types";

const Field = ({ label, value }: { readonly label: string; readonly value: string | undefined }) => (
  <p><strong>{label}</strong>：{value === undefined || value === "" ? "未提供" : value}</p>
);

const valueWithSource = (value: string | undefined, isDefault: boolean | undefined): string | undefined => {
  if (value === undefined || value === "") {
    return value;
  }
  return isDefault === true ? value + "（默认估计）" : value;
};

const attachedMaterialFallback = "已附加为演练上下文，不展示材料正文。";

const attachedMaterialCopy = (value: string | undefined): string =>
  value !== undefined &&
  value.trim().includes("可用于演练上下文") &&
  (value.trim().startsWith("已保存") || value.trim().startsWith("已添加"))
    ? value
    : attachedMaterialFallback;

const evidenceRequirementCopy = (requirement: string): string => {
  if (requirement === "required") {
    return "需要可观察证据";
  }
  if (requirement === "optional") {
    return "可作为补充观察";
  }
  return requirement;
};

export function ScenePreview({ draft, scene }: { readonly draft: DraftView | null; readonly scene?: SceneView | null }) {
  const preview: TemplatePreview | undefined = draft?.preview;
  const semantic = draft?.semantic_preview;
  const templateMaterials = preview?.materials ?? [];
  const attachedMaterials = preview?.attached_materials ?? [];
  return (
    <section aria-label="场景预览" className="scene-preview-card">
      <h2>演练简报</h2>
      <Field label="场景标题" value={scene?.title ?? preview?.title?.value} />
      <Field label="演练目标" value={preview?.goal?.value} />
      <h3>角色设定</h3>
      <Field label="你的角色" value={preview?.user_role?.value} />
      <Field label="AI 角色" value={preview?.ai_role?.value} />
      {semantic === undefined || semantic.roles.length === 0 ? null : (
        <ul>{semantic.roles.map((role) => <li key={`${role.kind}-${role.title}`}>{role.title}：{role.goal}</li>)}</ul>
      )}
      <h3>流程安排</h3>
      <ol>{(preview?.flow ?? []).map((item) => <li key={item.label}>{item.value}</li>)}</ol>
      {templateMaterials.length === 0 ? null : (
        <>
          <h3>模板背景</h3>
          <ul>{templateMaterials.map((item) => <li key={item.label}>{item.label}：{valueWithSource(item.value, item.is_default)}</li>)}</ul>
        </>
      )}
      {attachedMaterials.length === 0 ? null : (
        <>
          <h3>已附加材料</h3>
          <ul>
            {attachedMaterials.map((item) => (
              <li key={item.source_ref ?? item.label}>
                {item.label}{item.source_label === undefined ? "" : `（${item.source_label}）`}：{attachedMaterialCopy(item.value)}
              </li>
            ))}
          </ul>
        </>
      )}
      <Field label="复盘方式" value={preview?.review_method?.value} />
      <Field label="预计时长" value={valueWithSource(preview?.estimated_duration?.value, preview?.estimated_duration?.is_default)} />
      <Field label="压力程度" value={valueWithSource(preview?.pressure_level?.value, preview?.pressure_level?.is_default)} />
      <Field label="准备状态" value={preview?.ready_summary?.value} />
      <h3>准备提醒</h3>
      <ul>{(preview?.notes ?? []).map((item) => <li key={item.label}>{item.value}{item.is_default ? "（模板默认）" : ""}</li>)}</ul>
      {semantic === undefined ? null : (
        <>
          <h3>阶段安排</h3>
          <ol>
            {semantic.stages.map((stage) => (
              <li key={stage.title}>
                <strong>{stage.title}</strong>：{stage.goal}
              </li>
            ))}
          </ol>
          <h3>复盘维度</h3>
          <ul>{semantic.review_dimensions.map((dimension) => <li key={dimension.title}>{dimension.title}：{evidenceRequirementCopy(dimension.evidence_requirement)}</li>)}</ul>
        </>
      )}
    </section>
  );
}
