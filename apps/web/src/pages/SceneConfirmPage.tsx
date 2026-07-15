import { useEffect, useState } from "react";

import type { ApiClient } from "../api/client";
import type { ApiFailure, DraftView, MaterialVisibilityAccess, MaterialVisibilityEntryView, MaterialVisibilityInput, MaterialVisibilityMode, PreviewListItem, MaterialSummaryView, ModelConfigView, ScenarioCheckResult, SceneView, SessionView } from "../api/types";
import { ScenePreview } from "../components/ScenePreview";

interface SceneConfirmPageProps {
  readonly draft: DraftView | null;
  readonly scene: SceneView | null;
  readonly api: ApiClient;
  readonly initialCheck?: ScenarioCheckResult | undefined;
  readonly modelConfig?: ModelConfigView | null;
  readonly materials?: readonly MaterialSummaryView[];
  readonly onMaterialAttached?: (draft: DraftView, message: string) => void;
  readonly onChecked: (message: string) => void;
  readonly onStarted: (scene: SceneView, session: SessionView) => void;
  readonly onError: (error: ApiFailure) => void;
  readonly onGoToSettings?: () => void;
}

const checkStatusCopy: Record<ScenarioCheckResult["status"], string> = {
  ready: "场景检查通过",
  warning: "检查通过，有提醒",
  blocked: "需要修复"
};

const importedSceneCheck: ScenarioCheckResult = { status: "ready", ok: true, issues: [] };

const sourceRefForLibraryMaterial = (material: MaterialSummaryView): string => `material:${material.id}`;
const materialLibraryPageSize = 3;
const attachedMaterialsPageSize = 2;

const totalPages = (count: number, pageSize: number): number =>
  Math.max(1, Math.ceil(count / pageSize));

function SceneMaterialPagination({
  page,
  total,
  summary,
  onPageChange
}: {
  readonly page: number;
  readonly total: number;
  readonly summary: string;
  readonly onPageChange: (page: number) => void;
}) {
  if (total <= 1) {
    return null;
  }
  return (
    <div className="scene-materials-pagination" aria-label={summary}>
      <button type="button" className="secondary-action" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
      <span>{summary} · 第 {page} / {total} 页</span>
      <button type="button" className="secondary-action" disabled={page >= total} onClick={() => onPageChange(page + 1)}>下一页</button>
    </div>
  );
}

interface SceneCheckPanelProps {
  readonly result?: ScenarioCheckResult | null;
  readonly loading?: boolean;
  readonly error?: ApiFailure | null;
}

export function SceneCheckPanel({ result, loading = false, error = null }: SceneCheckPanelProps) {
  if (loading) {
    return (
      <section aria-label="场景检查结果" className="scene-check-card">
        <h3>正在检查草稿...</h3>
        <p>系统正在确认这个场景是否可以开始。</p>
      </section>
    );
  }

  if (error !== null) {
    return (
      <section aria-label="场景检查结果" className="scene-check-card">
        <h3>检查失败</h3>
        <p>{error.message}</p>
        <p>请重试检查，或返回首页重新创建草稿。</p>
      </section>
    );
  }

  if (result === null || result === undefined) {
    return (
      <section aria-label="场景检查结果" className="scene-check-card">
        <h3>等待检查</h3>
        <p>开始前需要先完成场景检查。</p>
      </section>
    );
  }

  return (
    <section aria-label="场景检查结果" className="scene-check-card">
      <h3>{checkStatusCopy[result.status]}</h3>
      {result.status === "blocked" ? <p>需要修复后才能开始演练。</p> : null}
      {result.issues.length > 0 ? (
        <ul className="compact-list">
          {result.issues.map((issue) => (
            <li key={issue.severity + issue.title + issue.message}>
              <strong>{issue.title}</strong>
              <p>{issue.message}</p>
              <p>{issue.suggestion}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p>当前草稿已通过开始前检查。</p>
      )}
    </section>
  );
}

function ModelConfigurationPanel({
  modelConfig,
  onGoToSettings
}: {
  readonly modelConfig?: ModelConfigView | null;
  readonly onGoToSettings: (() => void) | undefined;
}) {
  return (
    <section aria-label="模型配置" className="model-card">
      <h3>模型配置</h3>
      {modelConfig === null || modelConfig === undefined ? (
        <>
          <p>当前使用本地演示模式，可以先开始演练；如果要接入真实模型，请到设置页保存 OpenAI 兼容配置。</p>
          {onGoToSettings === undefined ? <p>可从顶部导航进入设置。</p> : <button type="button" onClick={onGoToSettings}>去设置</button>}
        </>
      ) : (
        <>
          <p>已启用真实模型配置。</p>
          <p>如需查看或切换具体模型，请前往设置页。</p>
        </>
      )}
    </section>
  );
}

type VisibilityRoleOption = NonNullable<DraftView["visibility_options"]>["roles"][number];
type VisibilityStageOption = NonNullable<DraftView["visibility_options"]>["stages"][number];

interface MaterialVisibilityEditorState {
  readonly mode: MaterialVisibilityMode;
  readonly selectedStageId?: string | undefined;
  readonly entries: readonly MaterialVisibilityEntryView[];
  readonly initialSignature: string;
  readonly saving: boolean;
  readonly error?: string | undefined;
}

const accessOptions: readonly { readonly access: MaterialVisibilityAccess; readonly label: string; readonly bulkLabel: string; readonly help: string }[] = [
  { access: "full", label: "全文", bulkLabel: "全部全文", help: "全文会进入角色上下文，AI 可基于正文互动。" },
  { access: "summary", label: "摘要", bulkLabel: "全部摘要", help: "摘要只包含标题、来源和说明。" },
  { access: "hidden", label: "不可见", bulkLabel: "全部不可见", help: "该角色在演练中不会收到这份材料。" }
];

const roleKindLabel = (kind: VisibilityRoleOption["kind"]): string => kind === "user" ? "真人用户" : "AI 角色";

const attachedMaterialFallback = "已附加为演练上下文，不展示材料正文。";

const safeAttachedMaterialCopy = (value: string | undefined): string =>
  value !== undefined &&
  value.trim().includes("可用于演练上下文") &&
  (value.trim().startsWith("已保存") || value.trim().startsWith("已添加"))
    ? value
    : attachedMaterialFallback;

const entrySignature = (mode: MaterialVisibilityMode, entries: readonly MaterialVisibilityEntryView[]): string =>
  JSON.stringify({
    mode,
    entries: [...entries].sort((left, right) =>
      `${left.stage_id ?? ""}:${left.role_id}`.localeCompare(`${right.stage_id ?? ""}:${right.role_id}`)
    )
  });

const accessForEntry = (
  entries: readonly MaterialVisibilityEntryView[],
  roleId: string,
  stageId: string | undefined
): MaterialVisibilityAccess => {
  const match = entries.find((entry) => entry.role_id === roleId && (stageId === undefined ? entry.stage_id === undefined : entry.stage_id === stageId));
  return match?.access ?? "full";
};

const normalizeVisibilityEntries = (
  visibility: PreviewListItem["visibility"] | undefined,
  roles: readonly VisibilityRoleOption[],
  stages: readonly VisibilityStageOption[]
): { readonly mode: MaterialVisibilityMode; readonly selectedStageId?: string | undefined; readonly entries: readonly MaterialVisibilityEntryView[] } => {
  const mode = visibility?.mode ?? "all_stages";
  if (mode === "per_stage") {
    const selectedStageId = stages[0]?.id;
    return {
      mode,
      selectedStageId,
      entries: stages.flatMap((stage) =>
        roles.map((role) => ({
          role_id: role.id,
          stage_id: stage.id,
          access: accessForEntry(visibility?.entries ?? [], role.id, stage.id)
        }))
      )
    };
  }
  return {
    mode: "all_stages",
    selectedStageId: stages[0]?.id,
    entries: roles.map((role) => ({
      role_id: role.id,
      access: accessForEntry(visibility?.entries ?? [], role.id, undefined)
    }))
  };
};

const createVisibilityEditorState = (
  material: PreviewListItem,
  roles: readonly VisibilityRoleOption[],
  stages: readonly VisibilityStageOption[]
): MaterialVisibilityEditorState => {
  const normalized = normalizeVisibilityEntries(material.visibility, roles, stages);
  return {
    ...normalized,
    initialSignature: entrySignature(normalized.mode, normalized.entries),
    saving: false
  };
};

const visibilitySummaryLabel = (material: PreviewListItem): string => {
  if (material.visibility?.summary_label !== undefined && material.visibility.summary_label.trim() !== "") {
    return material.visibility.summary_label;
  }
  if (material.visibility === undefined) {
    return "全部角色全文可见";
  }
  if (material.visibility.mode === "per_stage") {
    return "按阶段自定义";
  }
  const accesses = new Set(material.visibility.entries.map((entry) => entry.access));
  if (accesses.size === 1) {
    const onlyAccess = [...accesses][0];
    if (onlyAccess === "full") {
      return "全部角色全文可见";
    }
    if (onlyAccess === "summary") {
      return "全部角色摘要可见";
    }
    if (onlyAccess === "hidden") {
      return "全部角色不可见";
    }
  }
  return "自定义可见性";
};

const materialVisibilityInput = (editor: MaterialVisibilityEditorState): MaterialVisibilityInput => ({
  mode: editor.mode,
  entries: editor.entries.map((entry) => ({
    role_id: entry.role_id,
    ...(entry.stage_id === undefined ? {} : { stage_id: entry.stage_id }),
    access: entry.access
  }))
});

function RoleAccessRadioGroup({
  materialIndex,
  role,
  stageId,
  access,
  disabled,
  onChange
}: {
  readonly materialIndex: number;
  readonly role: VisibilityRoleOption;
  readonly stageId?: string | undefined;
  readonly access: MaterialVisibilityAccess;
  readonly disabled: boolean;
  readonly onChange: (access: MaterialVisibilityAccess) => void;
}) {
  const groupName = `material-visibility-${materialIndex}-${role.id}-${stageId ?? "all"}`;
  return (
    <div className="visibility-access-options" role="radiogroup" aria-label={`设置 ${role.display_name} 的材料可见性`}>
      {accessOptions.map((option) => (
        <label key={option.access} className="visibility-radio-pill">
          <input
            type="radio"
            name={groupName}
            checked={access === option.access}
            disabled={disabled}
            onChange={() => onChange(option.access)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function MaterialVisibilityEditor({
  material,
  materialIndex,
  editor,
  roles,
  stages,
  onPatch,
  onCancel,
  onSave
}: {
  readonly material: PreviewListItem;
  readonly materialIndex: number;
  readonly editor: MaterialVisibilityEditorState;
  readonly roles: readonly VisibilityRoleOption[];
  readonly stages: readonly VisibilityStageOption[];
  readonly onPatch: (patch: Partial<MaterialVisibilityEditorState>) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}) {
  const currentStageId = editor.mode === "per_stage" ? editor.selectedStageId ?? stages[0]?.id : undefined;
  const scopedEntries = editor.mode === "per_stage"
    ? editor.entries.filter((entry) => entry.stage_id === currentStageId)
    : editor.entries.filter((entry) => entry.stage_id === undefined);
  const uniqueAccesses = new Set(scopedEntries.map((entry) => entry.access));
  const selectedBulkAccess = uniqueAccesses.size === 1 ? [...uniqueAccesses][0] : undefined;
  const dirty = entrySignature(editor.mode, editor.entries) !== editor.initialSignature;
  const disabled = editor.saving || roles.length === 0;

  const updateEntries = (entries: readonly MaterialVisibilityEntryView[]) => onPatch({ entries, error: undefined });
  const applyBulkAccess = (access: MaterialVisibilityAccess) => {
    if (editor.mode === "per_stage" && currentStageId !== undefined) {
      updateEntries(editor.entries.map((entry) => entry.stage_id === currentStageId ? { ...entry, access } : entry));
      return;
    }
    updateEntries(roles.map((role) => ({ role_id: role.id, access })));
  };
  const updateRoleAccess = (roleId: string, access: MaterialVisibilityAccess) => {
    if (editor.mode === "per_stage" && currentStageId !== undefined) {
      updateEntries(editor.entries.map((entry) => entry.role_id === roleId && entry.stage_id === currentStageId ? { ...entry, access } : entry));
      return;
    }
    updateEntries(editor.entries.map((entry) => entry.role_id === roleId && entry.stage_id === undefined ? { ...entry, access } : entry));
  };
  const switchMode = (mode: MaterialVisibilityMode) => {
    if (mode === editor.mode) {
      return;
    }
    if (mode === "per_stage") {
      const entries = stages.flatMap((stage) =>
        roles.map((role) => ({
          role_id: role.id,
          stage_id: stage.id,
          access: accessForEntry(editor.entries, role.id, undefined)
        }))
      );
      onPatch({ mode, selectedStageId: stages[0]?.id, entries, error: undefined });
      return;
    }
    const stageId = currentStageId ?? stages[0]?.id;
    onPatch({
      mode,
      selectedStageId: stageId,
      entries: roles.map((role) => ({
        role_id: role.id,
        access: accessForEntry(editor.entries, role.id, stageId)
      })),
      error: undefined
    });
  };
  const copyCurrentStageToAllStages = () => {
    if (currentStageId === undefined) {
      return;
    }
    const currentEntries = new Map(roles.map((role) => [role.id, accessForEntry(editor.entries, role.id, currentStageId)]));
    updateEntries(stages.flatMap((stage) =>
      roles.map((role) => ({
        role_id: role.id,
        stage_id: stage.id,
        access: currentEntries.get(role.id) ?? "full"
      }))
    ));
  };
  const restoreAllFull = () => {
    if (editor.mode === "per_stage") {
      updateEntries(stages.flatMap((stage) => roles.map((role) => ({ role_id: role.id, stage_id: stage.id, access: "full" }))));
      return;
    }
    updateEntries(roles.map((role) => ({ role_id: role.id, access: "full" })));
  };

  return (
    <div className="material-visibility-editor">
      <p className="visibility-editor-intro">决定这份材料在演练中对哪些角色可见。全文会进入角色上下文；摘要只包含标题、来源和说明。</p>
      {roles.length === 0 ? <p className="visibility-editor-error">当前草稿暂未提供角色信息，材料会按默认全文可见处理。</p> : null}
      <div className="visibility-editor-block">
        <div className="visibility-editor-label">
          <strong>统一设置</strong>
          <span>{editor.mode === "per_stage" ? "应用到当前阶段" : "应用到全部角色和阶段"}</span>
        </div>
        <div className="visibility-bulk-options" role="radiogroup" aria-label={`统一设置 ${material.label} 的材料可见性`}>
          {accessOptions.map((option) => (
            <label key={option.access} className="visibility-bulk-option">
              <input
                type="radio"
                name={`material-visibility-bulk-${materialIndex}`}
                checked={selectedBulkAccess === option.access}
                disabled={disabled}
                onChange={() => applyBulkAccess(option.access)}
              />
              <span>
                <strong>{option.bulkLabel}</strong>
                <small>{option.help}</small>
              </span>
            </label>
          ))}
        </div>
      </div>
      <label className="visibility-advanced-toggle">
        <input
          type="checkbox"
          checked={editor.mode === "per_stage"}
          disabled={editor.saving || stages.length === 0}
          onChange={(event) => switchMode(event.currentTarget.checked ? "per_stage" : "all_stages")}
        />
        <span>
          <strong>按阶段单独配置</strong>
          <small>未开启时应用于全部阶段。</small>
        </span>
      </label>
      {editor.mode === "per_stage" ? (
        <div className="visibility-stage-panel">
          <div className="visibility-stage-tabs" role="tablist" aria-label="选择材料可见性阶段">
            {stages.map((stage) => (
              <button
                key={stage.id}
                type="button"
                className={stage.id === currentStageId ? "visibility-stage-tab visibility-stage-tab--active" : "visibility-stage-tab"}
                aria-pressed={stage.id === currentStageId}
                disabled={editor.saving}
                onClick={() => onPatch({ selectedStageId: stage.id, error: undefined })}
              >
                {stage.title}
              </button>
            ))}
          </div>
          <div className="visibility-stage-actions">
            <button type="button" className="secondary-action" disabled={editor.saving || currentStageId === undefined} onClick={copyCurrentStageToAllStages}>将当前阶段设置复制到全部阶段</button>
            <button type="button" className="secondary-action" disabled={editor.saving} onClick={restoreAllFull}>恢复全部阶段全文可见</button>
          </div>
        </div>
      ) : null}
      <div className="visibility-role-matrix">
        <div className="visibility-role-row visibility-role-row--header">
          <span>角色</span>
          <span>访问级别</span>
        </div>
        {roles.map((role) => (
          <div key={role.id} className="visibility-role-row">
            <div className="visibility-role-copy">
              <span className="visibility-role-badge">{roleKindLabel(role.kind)}</span>
              <strong>{role.display_name}</strong>
            </div>
            <RoleAccessRadioGroup
              materialIndex={materialIndex}
              role={role}
              stageId={currentStageId}
              access={accessForEntry(editor.entries, role.id, currentStageId)}
              disabled={disabled}
              onChange={(access) => updateRoleAccess(role.id, access)}
            />
          </div>
        ))}
      </div>
      {editor.error === undefined ? null : <p className="visibility-editor-error">{editor.error}</p>}
      <div className="visibility-editor-actions">
        <button type="button" className="secondary-action" disabled={editor.saving} onClick={onCancel}>取消</button>
        <button type="button" className="primary-action" disabled={!dirty || editor.saving || roles.length === 0} onClick={onSave}>{editor.saving ? "保存中..." : "保存配置"}</button>
      </div>
    </div>
  );
}

export function SceneConfirmPage({ draft, scene, api, initialCheck, modelConfig = null, materials = [], onMaterialAttached, onChecked, onStarted, onError, onGoToSettings }: SceneConfirmPageProps) {
  const [checkResult, setCheckResult] = useState<ScenarioCheckResult | null>(initialCheck ?? (draft === null && scene !== null ? importedSceneCheck : null));
  const [checkError, setCheckError] = useState<ApiFailure | null>(null);
  const [isChecking, setIsChecking] = useState(initialCheck === undefined && draft !== null);
  const [temporaryTitle, setTemporaryTitle] = useState("");
  const [temporaryText, setTemporaryText] = useState("");
  const [attachingMaterialIds, setAttachingMaterialIds] = useState<ReadonlySet<string>>(new Set<string>());
  const [isAttachingTemporary, setIsAttachingTemporary] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [materialLibraryPage, setMaterialLibraryPage] = useState(1);
  const [attachedMaterialsPage, setAttachedMaterialsPage] = useState(1);
  const attachedMaterials = draft?.preview?.attached_materials ?? [];
  const visibilityRoles = draft?.visibility_options?.roles ?? [];
  const visibilityStages = draft?.visibility_options?.stages ?? [];
  const [expandedVisibilitySourceRef, setExpandedVisibilitySourceRef] = useState<string | null>(null);
  const [visibilityEditors, setVisibilityEditors] = useState<Record<string, MaterialVisibilityEditorState>>({});
  const attachedSourceRefs = new Set(attachedMaterials.map((item) => item.source_ref).filter((value): value is string => typeof value === "string"));
  const canSubmitTemporaryMaterial = temporaryTitle.trim().length > 0 && temporaryText.trim().length > 0 && !isAttachingTemporary;

  const check = async (notify = true) => {
    if (draft === null) {
      return;
    }
    setIsChecking(true);
    setCheckError(null);
    const result = await api.checkDraft(draft.id);
    setIsChecking(false);
    if (!result.ok || result.data === undefined) {
      const error = result.error ?? { code: "api_error", message: "草稿检查失败，请重试。" };
      setCheckError(error);
      onError(error);
      return;
    }
    setCheckResult(result.data);
    if (notify) {
      onChecked(result.data.status === "ready" ? "场景检查通过，可以开始演练。" : checkStatusCopy[result.data.status]);
    }
  };

  useEffect(() => {
    if (draft !== null && initialCheck === undefined) {
      void check(false);
    }
  }, [draft?.id]);

  useEffect(() => {
    setMaterialLibraryPage((current) => Math.min(current, totalPages(materials.length, materialLibraryPageSize)));
  }, [materials.length]);

  useEffect(() => {
    setAttachedMaterialsPage((current) => Math.min(current, totalPages(attachedMaterials.length, attachedMaterialsPageSize)));
  }, [attachedMaterials.length]);

  if (draft === null && scene === null) {
    return <section className="empty-state-card"><h2>场景确认</h2><p>请先创建模板草稿。</p></section>;
  }

  const confirmAndStart = async () => {
    if (isStarting) {
      return;
    }
    if (checkResult?.status === "blocked") {
      onError({ code: "scenario_error", message: "需要修复后才能开始演练。" });
      return;
    }
    if (scene === null && draft === null) {
      onError({ code: "scenario_error", message: "请先创建或导入一个场景。" });
      return;
    }
    setIsStarting(true);
    const confirmed = scene === null && draft !== null ? await api.confirmDraft(draft.id, `confirm-${Date.now()}`) : { ok: true as const, data: { scene: scene as SceneView } };
    if (!confirmed.ok || confirmed.data === undefined) {
      setIsStarting(false);
      onError(confirmed.error ?? { code: "api_error", message: "确认场景失败。" });
      return;
    }
    const started = await api.startSession(confirmed.data.scene.id, `session-${Date.now()}`);
    if (!started.ok || started.data === undefined) {
      setIsStarting(false);
      onError(started.error ?? { code: "api_error", message: "开始演练失败。" });
      return;
    }
    onStarted(confirmed.data.scene, started.data.session);
  };

  const attachMaterial = async (material: MaterialSummaryView) => {
    if (draft === null) {
      return;
    }
    const sourceRef = sourceRefForLibraryMaterial(material);
    if (attachedSourceRefs.has(sourceRef) || attachingMaterialIds.has(material.id)) {
      return;
    }
    setAttachingMaterialIds((current) => new Set([...current, material.id]));
    const result = await api.attachMaterialToDraft(draft.id, material.id, `attach-material-${Date.now()}`);
    setAttachingMaterialIds((current) => {
      const next = new Set(current);
      next.delete(material.id);
      return next;
    });
    if (!result.ok || result.data === undefined) {
      onError(result.error ?? { code: "api_error", message: "附加材料失败，请稍后重试。" });
      return;
    }
    onMaterialAttached?.(result.data.draft, "材料已附加到当前草稿。");
  };

  const attachTemporaryMaterial = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (draft === null || !canSubmitTemporaryMaterial) {
      return;
    }
    setIsAttachingTemporary(true);
    const result = await api.attachTemporaryTextMaterialToDraft(draft.id, {
      title: temporaryTitle.trim(),
      text: temporaryText.trim(),
      idempotency_key: `attach-temporary-material-${Date.now()}`
    });
    setIsAttachingTemporary(false);
    if (!result.ok || result.data === undefined) {
      onError(result.error ?? { code: "api_error", message: "临时材料添加失败，请稍后重试。" });
      return;
    }
    setTemporaryTitle("");
    setTemporaryText("");
    onMaterialAttached?.(result.data.draft, "临时材料已添加到当前草稿。");
  };

  const visibilityEditorKey = (material: PreviewListItem, index: number): string => material.source_ref ?? `attached-material-${index}`;

  const patchVisibilityEditor = (key: string, patch: Partial<MaterialVisibilityEditorState>) => {
    setVisibilityEditors((current) => {
      const existing = current[key];
      if (existing === undefined) {
        return current;
      }
      return {
        ...current,
        [key]: {
          ...existing,
          ...patch
        }
      };
    });
  };

  const setVisibilityError = (key: string, message: string) => {
    patchVisibilityEditor(key, { saving: false, error: message });
  };

  const openVisibilityEditor = (material: PreviewListItem, index: number) => {
    const key = visibilityEditorKey(material, index);
    setExpandedVisibilitySourceRef(key);
    setVisibilityEditors((current) => current[key] === undefined
      ? {
          ...current,
          [key]: createVisibilityEditorState(material, visibilityRoles, visibilityStages)
        }
      : current);
  };

  const cancelVisibilityEditor = (key: string) => {
    setExpandedVisibilitySourceRef(null);
    setVisibilityEditors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const saveVisibilityEditor = async (material: PreviewListItem, index: number) => {
    if (draft === null) {
      return;
    }
    const key = visibilityEditorKey(material, index);
    const editor = visibilityEditors[key];
    if (editor === undefined) {
      return;
    }
    if (material.source_ref === undefined) {
      setVisibilityError(key, "这份材料缺少来源信息，暂时无法保存可见性。");
      return;
    }
    patchVisibilityEditor(key, { saving: true, error: undefined });
    const result = await api.updateDraftMaterialVisibility(draft.id, {
      source_ref: material.source_ref,
      visibility: materialVisibilityInput(editor),
      idempotency_key: `update-material-visibility-${Date.now()}`
    });
    if (!result.ok || result.data === undefined) {
      setVisibilityError(key, result.error?.message ?? "可见性配置保存失败，请稍后重试。");
      onError(result.error ?? { code: "api_error", message: "可见性配置保存失败，请稍后重试。" });
      return;
    }
    setExpandedVisibilitySourceRef(null);
    setVisibilityEditors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    onMaterialAttached?.(result.data.draft, "材料可见性已更新。");
  };

  const materialLibraryTotalPages = totalPages(materials.length, materialLibraryPageSize);
  const currentMaterialLibraryPage = Math.min(materialLibraryPage, materialLibraryTotalPages);
  const materialLibraryStart = (currentMaterialLibraryPage - 1) * materialLibraryPageSize;
  const visibleMaterialLibraryItems = materials.slice(materialLibraryStart, materialLibraryStart + materialLibraryPageSize);
  const attachedMaterialEntries = attachedMaterials.map((material, index) => ({
    material,
    index,
    key: visibilityEditorKey(material, index)
  }));
  const attachedMaterialsTotalPages = totalPages(attachedMaterialEntries.length, attachedMaterialsPageSize);
  const currentAttachedMaterialsPage = Math.min(attachedMaterialsPage, attachedMaterialsTotalPages);
  const attachedMaterialsStart = (currentAttachedMaterialsPage - 1) * attachedMaterialsPageSize;
  const visibleAttachedMaterialEntries = attachedMaterialEntries.slice(attachedMaterialsStart, attachedMaterialsStart + attachedMaterialsPageSize);
  const activeVisibilityEntry = expandedVisibilitySourceRef === null
    ? undefined
    : attachedMaterialEntries.find((entry) => entry.key === expandedVisibilitySourceRef);
  const activeVisibilityEditor = activeVisibilityEntry === undefined ? undefined : visibilityEditors[activeVisibilityEntry.key];
  const startDisabled = isStarting || isChecking || checkResult === null || checkResult.status === "blocked";

  return (
    <section className="scene-confirm-page">
      <header className="page-hero page-hero--compact">
        <div>
          <p className="eyebrow">开始前确认</p>
          <h2>开始前确认</h2>
          <p>确认角色、目标和复盘维度后，就可以进入专注演练。</p>
        </div>
      </header>
      <div className="scene-confirm-layout">
        <div className="scene-confirm-main">
          <ScenePreview draft={draft} scene={scene} />
        </div>
        <aside className="scene-confirm-aside">
          {draft === null && scene !== null ? (
            <section aria-label="场景检查结果" className="scene-check-card">
              <h3>场景检查通过</h3>
              <p>导入的场景已通过后端导入校验，可以开始演练。</p>
            </section>
          ) : (
            <SceneCheckPanel result={checkResult} loading={isChecking} error={checkError} />
          )}
          <ModelConfigurationPanel modelConfig={modelConfig} onGoToSettings={onGoToSettings} />
          {draft === null ? null : (
            <section aria-label="场景材料" className="materials-card scene-materials-card">
              <h3>场景材料</h3>
              <div className="scene-materials-section">
                <h4>引用材料库</h4>
                {materials.length === 0 ? (
                  <p>材料库为空，可先添加临时文本，或去材料页保存可复用材料。</p>
                ) : (
                  <>
                    <ul className="scene-material-list">
                      {visibleMaterialLibraryItems.map((material) => {
                        const isAttached = attachedSourceRefs.has(sourceRefForLibraryMaterial(material));
                        const isAttaching = attachingMaterialIds.has(material.id);
                        return (
                          <li key={material.id}>
                            <div>
                              <strong>{material.title}</strong>
                              <p>{material.source_label} · {material.summary}</p>
                            </div>
                            <button
                              type="button"
                              className="secondary-action"
                              disabled={isAttached || isAttaching}
                              onClick={() => void attachMaterial(material)}
                            >
                              {isAttached ? "已引用" : "引用到当前场景"}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <SceneMaterialPagination
                      page={currentMaterialLibraryPage}
                      total={materialLibraryTotalPages}
                      summary={`材料库 ${materialLibraryStart + 1}-${Math.min(materialLibraryStart + materialLibraryPageSize, materials.length)} / ${materials.length}`}
                      onPageChange={setMaterialLibraryPage}
                    />
                  </>
                )}
              </div>
              <form className="scene-materials-section" onSubmit={(event) => void attachTemporaryMaterial(event)}>
                <h4>添加临时文本材料</h4>
                <p>只用于当前草稿，不会保存到材料库。</p>
                <label className="form-field">
                  <span>临时材料标题</span>
                  <input value={temporaryTitle} onChange={(event) => setTemporaryTitle(event.currentTarget.value)} />
                </label>
                <label className="form-field">
                  <span>临时材料正文</span>
                  <textarea value={temporaryText} onChange={(event) => setTemporaryText(event.currentTarget.value)} />
                </label>
                <p>当前仅支持文本，文件材料后续支持。</p>
                <button type="submit" className="secondary-action" disabled={!canSubmitTemporaryMaterial}>添加到当前场景</button>
              </form>
              <div className="scene-materials-section attached-materials-visibility-section">
                <div className="scene-materials-heading">
                  <div>
                    <h4>已附加材料与可见性配置</h4>
                    <p>默认全部角色全文可见，可按角色或阶段收窄材料访问范围。</p>
                  </div>
                </div>
                {attachedMaterials.length === 0 ? (
                  <p>当前草稿还没有附加材料。引用材料库或添加临时文本后，可在这里配置可见性。</p>
                ) : (
                  <>
                    <ul className="attached-materials-visibility-list">
                      {visibleAttachedMaterialEntries.map(({ material, index, key }) => {
                      const expanded = expandedVisibilitySourceRef === key;
                      return (
                        <li key={key} className="material-visibility-card">
                          <div className="material-visibility-card__main">
                            <div className="material-visibility-card__copy">
                              <strong>{material.label}</strong>
                              <p>{material.source_label === undefined ? "" : `${material.source_label} · `}{safeAttachedMaterialCopy(material.value)}</p>
                            </div>
                            <span className="visibility-summary-badge" aria-label={`当前可见性：${visibilitySummaryLabel(material)}`}>{visibilitySummaryLabel(material)}</span>
                          </div>
                          <div className="material-visibility-card__actions">
                            <button
                              type="button"
                              className="secondary-action"
                              aria-expanded={expanded}
                              onClick={() => openVisibilityEditor(material, index)}
                            >
                              配置可见性
                            </button>
                          </div>
                        </li>
                      );
                    })}
                    </ul>
                    <SceneMaterialPagination
                      page={currentAttachedMaterialsPage}
                      total={attachedMaterialsTotalPages}
                      summary={`已附加 ${attachedMaterialsStart + 1}-${Math.min(attachedMaterialsStart + attachedMaterialsPageSize, attachedMaterialEntries.length)} / ${attachedMaterialEntries.length}`}
                      onPageChange={setAttachedMaterialsPage}
                    />
                  </>
                )}
              </div>
            </section>
          )}
          <div className="action-bar">
            {draft === null ? null : <button type="button" className="secondary-action" onClick={() => void check(true)}>检查草稿</button>}
            <button type="button" className="primary-action" onClick={confirmAndStart} disabled={startDisabled}>确认并开始演练</button>
          </div>
        </aside>
      </div>
        {activeVisibilityEntry !== undefined && activeVisibilityEditor !== undefined ? (
          <div className="material-visibility-modal-backdrop" role="presentation" onClick={() => cancelVisibilityEditor(activeVisibilityEntry.key)}>
            <section
              role="dialog"
              aria-modal="true"
              aria-label={`${activeVisibilityEntry.material.label} 可见性配置`}
              className="material-visibility-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="material-visibility-modal__header">
                <div>
                  <p className="eyebrow">材料可见性</p>
                  <h3>{activeVisibilityEntry.material.label}</h3>
                  <p>{activeVisibilityEntry.material.source_label === undefined ? "" : `${activeVisibilityEntry.material.source_label} · `}{safeAttachedMaterialCopy(activeVisibilityEntry.material.value)}</p>
                </div>
                <button type="button" className="secondary-action" onClick={() => cancelVisibilityEditor(activeVisibilityEntry.key)}>关闭</button>
              </header>
              <MaterialVisibilityEditor
                material={activeVisibilityEntry.material}
                materialIndex={activeVisibilityEntry.index}
                editor={activeVisibilityEditor}
                roles={visibilityRoles}
                stages={visibilityStages}
                onPatch={(patch) => patchVisibilityEditor(activeVisibilityEntry.key, patch)}
                onCancel={() => cancelVisibilityEditor(activeVisibilityEntry.key)}
                onSave={() => void saveVisibilityEditor(activeVisibilityEntry.material, activeVisibilityEntry.index)}
              />
            </section>
          </div>
        ) : null}
    </section>
  );
}
