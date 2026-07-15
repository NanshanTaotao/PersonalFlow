import { useState } from "react";

import type { ApiClient, ComplexScenarioConfigInput } from "../api/client";
import type { ApiFailure, DraftView } from "../api/types";

interface ScenarioBuilderPageProps {
  readonly api: ApiClient;
  readonly onDraftCreated: (draft: DraftView) => void;
  readonly onError: (error: ApiFailure) => void;
}

export const defaultComplexScenarioConfig: ComplexScenarioConfigInput = {
  title: "增长平台项目评审",
  goal: "验证增长平台方案的证据链、风险和落地计划",
  user_role: "方案负责人",
  ai_roles: [
    { name: "业务评审", focus: "业务目标、指标口径和收益证据" },
    { name: "技术评审", focus: "系统复杂度、稳定性和上线风险" }
  ],
  stages: [
    { name: "开场", rounds: 1, follow_up_strategy: "确认目标和背景" },
    { name: "证据追问", rounds: 2, follow_up_strategy: "连续追问指标证据和取舍" },
    { name: "风险收束", rounds: 1, follow_up_strategy: "收束风险、限制和下一步计划" }
  ],
  termination: "完成风险收束后结束并进入复盘"
};

export const minimumComplexAiRoles = 2;

const createBlankComplexAiRole = (nextIndex: number): ComplexScenarioConfigInput["ai_roles"][number] => ({
  name: `AI 角色 ${nextIndex}`,
  focus: "补充这个角色关注的问题、风险或证据。"
});

export const addComplexAiRole = (config: ComplexScenarioConfigInput): ComplexScenarioConfigInput => ({
  ...config,
  ai_roles: [
    ...config.ai_roles,
    createBlankComplexAiRole(config.ai_roles.length + 1)
  ]
});

export const updateComplexAiRole = (
  config: ComplexScenarioConfigInput,
  index: number,
  patch: Partial<ComplexScenarioConfigInput["ai_roles"][number]>
): ComplexScenarioConfigInput => ({
  ...config,
  ai_roles: config.ai_roles.map((role, roleIndex) => roleIndex === index ? { ...role, ...patch } : role)
});

export const removeComplexAiRole = (
  config: ComplexScenarioConfigInput,
  index: number
): ComplexScenarioConfigInput => {
  if (config.ai_roles.length <= minimumComplexAiRoles) {
    return config;
  }
  return {
    ...config,
    ai_roles: config.ai_roles.filter((_role, roleIndex) => roleIndex !== index)
  };
};

export const createComplexScenarioDraft = async (
  api: ApiClient,
  config: ComplexScenarioConfigInput,
  onDraftCreated: (draft: DraftView) => void,
  onError: (error: ApiFailure) => void
) => {
  const result = await api.createDraftFromComplexConfig({
    ...config,
    idempotency_key: `complex-config-${Date.now()}`
  });
  if (!result.ok || result.data === undefined) {
    onError(result.error ?? { code: "api_error", message: "复杂场景生成失败，请检查配置后重试。" });
    return;
  }
  onDraftCreated(result.data.draft);
};

export function ComplexScenarioPreview({ config }: { readonly config: ComplexScenarioConfigInput }) {
  return (
    <section aria-label="场景预览" className="scenario-builder-card scenario-preview-panel">
      <h3>预览</h3>
      <p>{config.user_role} 将面对 {config.ai_roles.map((role) => role.name).join("、")}。</p>
      <ul aria-label="AI 角色预览" className="scenario-preview-list">
        {config.ai_roles.map((role, index) => (
          <li key={index}>{role.name}：{role.focus}</li>
        ))}
      </ul>
      <ul aria-label="阶段预览" className="scenario-preview-list">
        {config.stages.map((stage, index) => (
          <li key={index}>{stage.name}：{stage.follow_up_strategy}（{stage.rounds} 轮）</li>
        ))}
      </ul>
      <p>安全提醒：普通页面只展示配置摘要，详细编排会由系统在后台处理。</p>
    </section>
  );
}

export function ScenarioBuilderPage({ api, onDraftCreated, onError }: ScenarioBuilderPageProps) {
  const [config, setConfig] = useState<ComplexScenarioConfigInput>(defaultComplexScenarioConfig);

  const updateRole = (index: number, patch: Partial<ComplexScenarioConfigInput["ai_roles"][number]>) => {
    setConfig((current) => updateComplexAiRole(current, index, patch));
  };

  const updateStage = (index: number, patch: Partial<ComplexScenarioConfigInput["stages"][number]>) => {
    setConfig((current) => ({
      ...current,
      stages: current.stages.map((stage, stageIndex) => stageIndex === index ? { ...stage, ...patch } : stage)
    }));
  };

  return (
    <section className="scenario-builder-page">
      <header className="scenario-builder-hero">
        <div>
          <p className="eyebrow">复杂场景</p>
          <h2>复杂场景配置</h2>
          <p>用产品级参数配置多阶段、多 AI、多轮追问场景；生成后会进入现有场景检查和确认流程。</p>
        </div>
        <button type="button" className="primary-action" onClick={() => void createComplexScenarioDraft(api, config, onDraftCreated, onError)}>生成场景草稿</button>
      </header>
      <div className="scenario-builder-grid">
        <section className="scenario-builder-card">
          <h3>基础信息</h3>
          <label className="form-field">
            <span>场景标题</span>
            <input value={config.title} onChange={(event) => setConfig((current) => ({ ...current, title: event.target.value }))} />
          </label>
          <label className="form-field">
            <span>演练目标</span>
            <textarea value={config.goal} onChange={(event) => setConfig((current) => ({ ...current, goal: event.target.value }))} />
          </label>
          <label className="form-field">
            <span>用户角色</span>
            <input value={config.user_role} onChange={(event) => setConfig((current) => ({ ...current, user_role: event.target.value }))} />
          </label>
          <label className="form-field">
            <span>终止条件</span>
            <textarea value={config.termination} onChange={(event) => setConfig((current) => ({ ...current, termination: event.target.value }))} />
          </label>
        </section>
        <section aria-label="AI 角色" className="scenario-builder-card">
          <h3>AI 角色</h3>
          <p>已配置 {config.ai_roles.length} 个 AI 角色，复杂场景至少保留 2 个 AI 角色。</p>
          {config.ai_roles.map((role, index) => (
            <div key={index} className="scenario-config-row">
              <label className="form-field">
                <span>AI 角色</span>
                <input value={role.name} onChange={(event) => updateRole(index, { name: event.target.value })} />
              </label>
              <label className="form-field">
                <span>关注点</span>
                <input value={role.focus} onChange={(event) => updateRole(index, { focus: event.target.value })} />
              </label>
              <button
                type="button"
                disabled={config.ai_roles.length <= minimumComplexAiRoles}
                onClick={() => setConfig((current) => removeComplexAiRole(current, index))}
              >
                删除 AI 角色
              </button>
            </div>
          ))}
          <button type="button" className="secondary-action" onClick={() => setConfig((current) => addComplexAiRole(current))}>添加 AI 角色</button>
        </section>
        <section aria-label="阶段配置" className="scenario-builder-card">
          <h3>阶段</h3>
          {config.stages.map((stage, index) => (
            <div key={index} className="scenario-config-row">
              <label className="form-field">
                <span>阶段</span>
                <input value={stage.name} onChange={(event) => updateStage(index, { name: event.target.value })} />
              </label>
              <label className="form-field">
                <span>每阶段轮次</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={stage.rounds}
                  onChange={(event) => updateStage(index, { rounds: Number(event.target.value) })}
                />
              </label>
              <label className="form-field">
                <span>追问策略</span>
                <input value={stage.follow_up_strategy} onChange={(event) => updateStage(index, { follow_up_strategy: event.target.value })} />
              </label>
            </div>
          ))}
        </section>
        <ComplexScenarioPreview config={config} />
      </div>
    </section>
  );
}
