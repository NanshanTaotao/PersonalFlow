import type { AiTurnObservabilityView, DraftView, ReviewReport, SceneView, SessionView } from "../api/types";

interface DebugPageProps {
  readonly draft: DraftView | null;
  readonly scene: SceneView | null;
  readonly session: SessionView | null;
  readonly review: ReviewReport | null;
  readonly aiTurnObservability: AiTurnObservabilityView | null;
}

export function DebugPage({ draft, scene, session, review, aiTurnObservability }: DebugPageProps) {
  return (
    <section>
      <h2>高级 / 调试视图</h2>
      <p>此页只展示 Product API 已裁剪的安全摘要、ID、版本和 hash；不展示密钥、完整 prompt、完整 context、provider 请求响应或存储行。</p>
      <dl>
        <dt>Draft ID</dt><dd>{draft?.id ?? "无"}</dd>
        <dt>Scene ID</dt><dd>{scene?.id ?? "无"}</dd>
        <dt>Normalized scenario safe hash</dt><dd>{scene?.normalized_hash ?? "API 尚未返回"}</dd>
        <dt>Session ID</dt><dd>{session?.id ?? "无"}</dd>
        <dt>Scenario ID</dt><dd>{session?.scenario_id ?? "无"}</dd>
        <dt>State version</dt><dd>{session?.view.state_version ?? "无"}</dd>
        <dt>Status</dt><dd>{session?.status ?? "无"}</dd>
        <dt>Prompt/context hash</dt><dd>当前 Product API 未返回专用安全摘要，Web 不自行序列化内部场景。</dd>
        <dt>AI adapter kind</dt><dd>{aiTurnObservability?.adapter_kind ?? "无"}</dd>
        <dt>AI model config ID</dt><dd>{aiTurnObservability?.model_config_id ?? "无"}</dd>
        <dt>AI provider</dt><dd>{aiTurnObservability?.provider ?? "无"}</dd>
        <dt>AI model</dt><dd>{aiTurnObservability?.model ?? "无"}</dd>
        <dt>Review ID</dt><dd>{review?.id ?? "无"}</dd>
        <dt>Review adapter kind</dt><dd>{review?.review_adapter_kind ?? "无"}</dd>
      </dl>
      <h3>AI 可见历史摘要</h3>
      <ul>
        {(aiTurnObservability?.visible_history ?? []).map((entry) => (
          <li key={`${entry.event_id}-${entry.sequence}`}>
            {entry.event_id} · seq {entry.sequence} · {entry.actor_id ?? "unknown"} · {entry.step_id ?? "unknown"} · {entry.text_summary}
          </li>
        ))}
      </ul>
      <h3>事件流摘要</h3>
      <p>Task 11 Web 不新增私有事件接口；当前只展示 review evidence refs 中由 API 返回的安全事件引用。</p>
      <ul>
        {(review?.evidence_refs ?? []).map((refValue) => (
          <li key={`${refValue.event_id}-${refValue.sequence}`}>{refValue.event_id} · seq {refValue.sequence} · {refValue.actor_id} · {refValue.step_id}</li>
        ))}
      </ul>
    </section>
  );
}
