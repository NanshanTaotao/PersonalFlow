import { useEffect } from "react";

import type { ApiClient } from "../api/client";
import type { ApiFailure, ModelConfigView } from "../api/types";

export interface SettingsState {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly displayName: string;
  readonly apiKey: string;
  readonly status: "idle" | "loading" | "saving" | "saved" | "testing" | "testSucceeded" | "failed";
  readonly message: string;
  readonly modelConfig: ModelConfigView | undefined;
  readonly modelConfigs: readonly ModelConfigView[];
  readonly defaultModelConfigId: string | null;
  readonly editingModelConfigId: string | null;
}

export type SettingsAction =
  | { readonly type: "field"; readonly field: "provider" | "baseUrl" | "model" | "displayName" | "apiKey"; readonly value: string }
  | { readonly type: "loading" }
  | { readonly type: "listSucceeded"; readonly modelConfigs: readonly ModelConfigView[]; readonly defaultModelConfigId?: string | null }
  | { readonly type: "saving" }
  | { readonly type: "saveSucceeded"; readonly modelConfig: ModelConfigView }
  | { readonly type: "updateSucceeded"; readonly modelConfig: ModelConfigView }
  | { readonly type: "hydrateModelConfig"; readonly modelConfig: ModelConfigView }
  | { readonly type: "selectDefault"; readonly modelConfigId: string }
  | { readonly type: "startEdit"; readonly modelConfig: ModelConfigView }
  | { readonly type: "cancelEdit" }
  | { readonly type: "deleteSucceeded"; readonly modelConfigId: string }
  | { readonly type: "testing" }
  | { readonly type: "testSucceeded"; readonly message: string }
  | { readonly type: "failed"; readonly error: ApiFailure };

export const initialSettingsState: SettingsState = {
  provider: "openai-compatible",
  baseUrl: "https://example.test/v1",
  model: "gpt-test",
  displayName: "PersonalFlow 默认模型",
  apiKey: "",
  status: "idle",
  message: "",
  modelConfig: undefined,
  modelConfigs: [],
  defaultModelConfigId: null,
  editingModelConfigId: null
};

const upsertModelConfig = (modelConfigs: readonly ModelConfigView[], modelConfig: ModelConfigView): readonly ModelConfigView[] =>
  modelConfigs.some((current) => current.id === modelConfig.id)
    ? modelConfigs.map((current) => current.id === modelConfig.id ? modelConfig : current)
    : [...modelConfigs, modelConfig];

const currentDefault = (modelConfigs: readonly ModelConfigView[], defaultModelConfigId: string | null): ModelConfigView | undefined =>
  defaultModelConfigId === null ? undefined : modelConfigs.find((modelConfig) => modelConfig.id === defaultModelConfigId);

export const deleteModelConfigConfirmationText = (modelConfig: ModelConfigView): string =>
  `删除模型配置 ${modelConfig.display_name}？此操作不可撤销。删除后该配置不能再用于测试连接或后续 AI 调用。如需继续，请确认删除。`;

export const buildDeleteModelConfigIdempotencyKey = (modelConfig: ModelConfigView): string =>
  `delete-model-config-${modelConfig.id}`;

export const settingsReducer = (state: SettingsState, action: SettingsAction): SettingsState => {
  switch (action.type) {
    case "field":
      return { ...state, [action.field]: action.value, status: "idle", message: "" };
    case "loading":
      return { ...state, status: "loading", message: "正在读取已保存模型配置。" };
    case "listSucceeded": {
      const defaultModelConfigId = action.defaultModelConfigId === undefined
        ? state.defaultModelConfigId ?? action.modelConfigs[0]?.id ?? null
        : action.defaultModelConfigId;
      return {
        ...state,
        status: "idle",
        message: action.modelConfigs.length === 0 ? "还没有保存模型配置，请先新增一条 OpenAI 兼容配置。" : "已读取已保存模型配置。",
        modelConfigs: action.modelConfigs,
        defaultModelConfigId,
        modelConfig: currentDefault(action.modelConfigs, defaultModelConfigId)
      };
    }
    case "saving":
      return { ...state, status: "saving", message: "正在保存模型配置。" };
    case "saveSucceeded": {
      const existingModelConfigs = state.modelConfigs ?? [];
      const modelConfigs = upsertModelConfig(existingModelConfigs, action.modelConfig);
      const isFirstConfig = existingModelConfigs.length === 0;
      const defaultModelConfigId = state.defaultModelConfigId ?? action.modelConfig.id;
      return {
        ...state,
        apiKey: "",
        status: "saved",
        message: isFirstConfig ? "配置已保存，已自动设为当前默认模型。" : "配置已保存，密钥输入已清空。",
        modelConfigs,
        defaultModelConfigId,
        modelConfig: currentDefault(modelConfigs, defaultModelConfigId),
        editingModelConfigId: null
      };
    }
    case "updateSucceeded": {
      const modelConfigs = upsertModelConfig(state.modelConfigs, action.modelConfig);
      return {
        ...state,
        apiKey: "",
        status: "saved",
        message: "配置已更新，密钥输入已清空。",
        modelConfigs,
        modelConfig: currentDefault(modelConfigs, state.defaultModelConfigId),
        editingModelConfigId: null
      };
    }
    case "hydrateModelConfig":
      return settingsReducer({
        ...state,
        provider: action.modelConfig.provider,
        baseUrl: action.modelConfig.base_url,
        model: action.modelConfig.model,
        displayName: action.modelConfig.display_name,
        apiKey: "",
        status: "idle",
        message: "已恢复已保存模型配置。"
      }, { type: "listSucceeded", modelConfigs: upsertModelConfig(state.modelConfigs, action.modelConfig), defaultModelConfigId: action.modelConfig.id });
    case "selectDefault":
      return {
        ...state,
        status: "idle",
        message: "当前默认模型已更新。",
        defaultModelConfigId: action.modelConfigId,
        modelConfig: state.modelConfigs.find((modelConfig) => modelConfig.id === action.modelConfigId)
      };
    case "startEdit":
      return {
        ...state,
        provider: action.modelConfig.provider,
        baseUrl: action.modelConfig.base_url,
        model: action.modelConfig.model,
        displayName: action.modelConfig.display_name,
        apiKey: "",
        status: "idle",
        message: `正在编辑 ${action.modelConfig.display_name}。`,
        editingModelConfigId: action.modelConfig.id
      };
    case "cancelEdit":
      return {
        ...state,
        provider: initialSettingsState.provider,
        baseUrl: initialSettingsState.baseUrl,
        model: initialSettingsState.model,
        displayName: initialSettingsState.displayName,
        apiKey: "",
        status: "idle",
        message: "已取消编辑。",
        editingModelConfigId: null
      };
    case "deleteSucceeded": {
      const modelConfigs = state.modelConfigs.filter((modelConfig) => modelConfig.id !== action.modelConfigId);
      const deletedDefault = state.defaultModelConfigId === action.modelConfigId;
      const defaultModelConfigId = deletedDefault ? modelConfigs[0]?.id ?? null : state.defaultModelConfigId;
      return {
        ...state,
        status: "saved",
        message: deletedDefault
          ? (defaultModelConfigId === null ? "当前没有默认模型，请新增或选择配置。" : "默认模型已切换到剩余配置。")
          : "配置已删除。",
        modelConfigs,
        defaultModelConfigId,
        modelConfig: currentDefault(modelConfigs, defaultModelConfigId),
        editingModelConfigId: state.editingModelConfigId === action.modelConfigId ? null : state.editingModelConfigId,
        apiKey: ""
      };
    }
    case "testing":
      return { ...state, status: "testing", message: "正在测试连接。" };
    case "testSucceeded":
      return { ...state, status: "testSucceeded", message: action.message };
    case "failed":
      return { ...state, status: "failed", message: action.error.message };
    default:
      return state;
  }
};

interface SettingsPageProps {
  readonly state: SettingsState;
  readonly dispatch: (action: SettingsAction) => void;
  readonly api: ApiClient;
  readonly onSaved: (modelConfig: ModelConfigView) => void;
  readonly onDefaultChanged?: (modelConfig: ModelConfigView | null) => void;
  readonly onError: (error: ApiFailure) => void;
}

export const testSavedModelConfigConnection = async ({
  api,
  dispatch,
  modelConfig,
  onError,
  idempotencyKey = `test-${Date.now()}`
}: {
  readonly api: Pick<ApiClient, "testModelConfig">;
  readonly dispatch: (action: SettingsAction) => void;
  readonly modelConfig: ModelConfigView | undefined;
  readonly onError: (error: ApiFailure) => void;
  readonly idempotencyKey?: string;
}): Promise<void> => {
  if (modelConfig === undefined) {
    const error = { code: "validation_error", message: "请先保存或选择模型配置。" };
    dispatch({ type: "failed", error });
    onError(error);
    return;
  }
  dispatch({ type: "testing" });
  const result = await api.testModelConfig(modelConfig.id, idempotencyKey);
  if (!result.ok || result.data === undefined) {
    const error = result.error ?? { code: "api_error", message: "连接测试失败。" };
    dispatch({ type: "failed", error });
    onError(error);
    return;
  }
  if (!result.data.ok) {
    const error = {
      code: "model_connection_failed",
      message: result.data.message ?? "连接测试失败，请检查模型服务配置。"
    };
    dispatch({ type: "failed", error });
    onError(error);
    return;
  }
  dispatch({ type: "testSucceeded", message: result.data.message ?? `连接成功：${result.data.model}` });
};

const modelProviderLabel = (provider: string): string =>
  provider === "openai-compatible" ? "OpenAI 兼容服务" : "自定义模型服务";

function ModelConfigDetails({ modelConfig }: { readonly modelConfig: ModelConfigView }) {
  return (
    <dl className="settings-model-details">
      <dt>服务类型</dt><dd>{modelProviderLabel(modelConfig.provider)}</dd>
      <dt>模型服务地址</dt><dd>{modelConfig.base_url}</dd>
      <dt>模型名称</dt><dd>{modelConfig.model}</dd>
      <dt>密钥状态</dt><dd>{modelConfig.has_api_key ? "已保存密钥" : "未保存密钥"}</dd>
    </dl>
  );
}

export function SettingsPage({ state, dispatch, api, onSaved, onDefaultChanged, onError }: SettingsPageProps) {
  const modelConfigs = state.modelConfigs.length > 0 ? state.modelConfigs : (state.modelConfig === undefined ? [] : [state.modelConfig]);
  const defaultModelConfigId = state.defaultModelConfigId ?? state.modelConfig?.id ?? null;
  const selectedModelConfig = modelConfigs.find((modelConfig) => modelConfig.id === defaultModelConfigId);
  const editingModelConfig = state.editingModelConfigId === null ? undefined : modelConfigs.find((modelConfig) => modelConfig.id === state.editingModelConfigId);

  useEffect(() => {
    dispatch({ type: "loading" });
    void api.listModelConfigs().then((result) => {
      if (!result.ok || result.data === undefined) {
        const error = result.error ?? { code: "api_error", message: "已保存模型配置读取失败，可继续新增配置。" };
        dispatch({ type: "failed", error });
        onError(error);
        return;
      }
      const serverDefaultId = result.data.default_model_config_id;
      const defaultId = serverDefaultId !== null && result.data.model_configs.some((modelConfig) => modelConfig.id === serverDefaultId)
        ? serverDefaultId
        : result.data.model_configs[0]?.id ?? null;
      dispatch({ type: "listSucceeded", modelConfigs: result.data.model_configs, defaultModelConfigId: defaultId });
      onDefaultChanged?.(defaultId === null ? null : result.data.model_configs.find((modelConfig) => modelConfig.id === defaultId) ?? null);
    });
  }, [api, dispatch, onDefaultChanged, onError]);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    dispatch({ type: "saving" });
    const input = {
      provider: state.provider,
      base_url: state.baseUrl,
      model: state.model,
      display_name: state.displayName,
      ...(state.apiKey.length > 0 ? { api_key: state.apiKey } : {}),
      idempotency_key: `model-${Date.now()}`
    };
    const result = editingModelConfig === undefined
      ? await api.createModelConfig({ ...input, api_key: state.apiKey })
      : await api.patchModelConfig(editingModelConfig.id, input);
    if (!result.ok || result.data === undefined) {
      const error = result.error ?? { code: "api_error", message: "模型配置保存失败。" };
      dispatch({ type: "failed", error });
      onError(error);
      return;
    }
    const shouldPromoteToDefault =
      state.defaultModelConfigId === null ||
      (editingModelConfig !== undefined && editingModelConfig.id === defaultModelConfigId);
    dispatch({ type: editingModelConfig === undefined ? "saveSucceeded" : "updateSucceeded", modelConfig: result.data.model_config });
    onSaved(result.data.model_config);
    if (shouldPromoteToDefault) {
      onDefaultChanged?.(result.data.model_config);
    }
  };

  const testConnection = (targetModelConfig = selectedModelConfig) =>
    testSavedModelConfigConnection({ api, dispatch, modelConfig: targetModelConfig, onError });

  const selectDefault = async (modelConfig: ModelConfigView) => {
    const result = await api.setDefaultModelConfig(modelConfig.id, `default-model-config-${modelConfig.id}`);
    if (!result.ok || result.data === undefined) {
      const error = result.error ?? { code: "api_error", message: "默认模型更新失败。" };
      dispatch({ type: "failed", error });
      onError(error);
      return;
    }
    dispatch({ type: "selectDefault", modelConfigId: modelConfig.id });
    onDefaultChanged?.(result.data.model_config);
  };

  const deleteConfig = async (modelConfig: ModelConfigView) => {
    if (typeof window !== "undefined" && !window.confirm(deleteModelConfigConfirmationText(modelConfig))) {
      return;
    }
    const remaining = modelConfigs.filter((current) => current.id !== modelConfig.id);
    const nextDefaultId = defaultModelConfigId === modelConfig.id ? remaining[0]?.id ?? null : defaultModelConfigId;
    const result = await api.deleteModelConfig(modelConfig.id, buildDeleteModelConfigIdempotencyKey(modelConfig), "user_confirmed_delete_model_config");
    if (!result.ok) {
      const error = result.error ?? { code: "api_error", message: "删除配置失败。" };
      dispatch({ type: "failed", error });
      onError(error);
      return;
    }
    dispatch({ type: "deleteSucceeded", modelConfigId: modelConfig.id });
    onDefaultChanged?.(nextDefaultId === null ? null : remaining.find((current) => current.id === nextDefaultId) ?? null);
  };

  return (
    <section className="settings-page">
      <header className="page-hero page-hero--compact">
        <div>
          <p className="eyebrow">设置中心</p>
          <h2>模型设置</h2>
        </div>
      </header>
      <div className="settings-layout">
        <nav aria-label="设置分区" className="settings-section-nav">
          <a href="#settings-model" aria-current="true">模型配置</a>
          <span>本地数据</span>
          <span>演练偏好</span>
        </nav>
        <div id="settings-model" className="settings-content">
          <p className="settings-trust-copy">
            PersonalFlow 优先使用本地数据；模型配置只用于本机 API 调用。当前支持 OpenAI 兼容服务。
          </p>
          <section className="settings-card settings-default-card">
            <div>
              <p className="eyebrow">默认模型</p>
              <h3>当前默认模型</h3>
            </div>
            {selectedModelConfig === undefined ? (
              <div className="settings-default-empty">
                <p>还没有默认模型。请先新增一条 OpenAI 兼容配置，保存后即可用于演练中的 AI 回合。</p>
                <button type="button" onClick={() => void testConnection()} disabled>测试连接</button>
              </div>
            ) : (
              <div className="settings-default-body">
                <div>
                  <strong>{selectedModelConfig.display_name}</strong>
                  <ModelConfigDetails modelConfig={selectedModelConfig} />
                </div>
                <button type="button" className="secondary-action" onClick={() => void testConnection(selectedModelConfig)} disabled={state.status === "testing"}>测试连接</button>
              </div>
            )}
          </section>
          <p aria-live="polite">{state.message}</p>
          <section className="settings-card">
            <h3>已保存模型</h3>
            {modelConfigs.length === 0 ? (
              <p>还没有保存模型配置，请先新增一条 OpenAI 兼容配置。请先保存或选择模型配置后再测试连接。</p>
            ) : (
              <ul className="settings-model-list">
                {modelConfigs.map((modelConfig) => (
                  <li key={modelConfig.id} className="settings-model-card">
                    <strong>{modelConfig.display_name}</strong>
                    {modelConfig.id === defaultModelConfigId ? <span> 当前默认</span> : null}
                    <ModelConfigDetails modelConfig={modelConfig} />
                    <div className="control-row">
                      <button type="button" onClick={() => void selectDefault(modelConfig)} disabled={modelConfig.id === defaultModelConfigId}>设为默认</button>
                      <button type="button" onClick={() => dispatch({ type: "startEdit", modelConfig })}>编辑配置</button>
                      <button type="button" onClick={() => void deleteConfig(modelConfig)} aria-label={`删除配置 ${modelConfig.display_name}`} title={deleteModelConfigConfirmationText(modelConfig)}>删除配置</button>
                      <button type="button" onClick={() => void testConnection(modelConfig)} disabled={state.status === "testing"} aria-label={`测试连接 ${modelConfig.display_name}`}>测试连接</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <form className="settings-card settings-card--secondary" onSubmit={submit}>
            <h3>{editingModelConfig === undefined ? "新增模型配置" : `编辑配置：${editingModelConfig.display_name}`}</h3>
            <p>需要接入新的 OpenAI 兼容服务时，再在这里新增或更新配置。</p>
            <div className="form-field"><span>服务类型</span><strong>{modelProviderLabel(state.provider)}</strong></div>
            <label className="form-field"><span>模型服务地址</span><input value={state.baseUrl} onChange={(event) => dispatch({ type: "field", field: "baseUrl", value: event.currentTarget.value })} /></label>
            <label className="form-field"><span>模型名称</span><input value={state.model} onChange={(event) => dispatch({ type: "field", field: "model", value: event.currentTarget.value })} /></label>
            <label className="form-field"><span>显示名称</span><input value={state.displayName} onChange={(event) => dispatch({ type: "field", field: "displayName", value: event.currentTarget.value })} /></label>
            <label className="form-field"><span>访问密钥</span><input type="password" value={state.apiKey} onChange={(event) => dispatch({ type: "field", field: "apiKey", value: event.currentTarget.value })} autoComplete="off" placeholder={editingModelConfig === undefined ? "新增配置需要填写" : "留空则不更新密钥"} /></label>
            <div className="control-row">
              <button type="submit" disabled={state.status === "saving" || (editingModelConfig === undefined && state.apiKey.length === 0)}>{editingModelConfig === undefined ? "保存配置" : "保存编辑"}</button>
              {editingModelConfig === undefined ? null : <button type="button" onClick={() => dispatch({ type: "cancelEdit" })}>取消编辑</button>}
              <button type="button" onClick={() => void testConnection()} disabled={state.status === "testing" || selectedModelConfig === undefined}>测试连接</button>
            </div>
          </form>
          <div className="settings-placeholder-grid" aria-label="本地数据与演练偏好说明">
            <section className="settings-card settings-note-card">
              <h3>本地数据</h3>
              <p>演练、草稿、复盘和模型配置保存在本机数据库中。本页不提供批量导出或清空入口。</p>
            </section>
            <section className="settings-card settings-note-card">
              <h3>演练偏好</h3>
              <p>当前演练偏好由场景模板和开始前确认页决定，不在设置页伪装未实现的全局开关。</p>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}
