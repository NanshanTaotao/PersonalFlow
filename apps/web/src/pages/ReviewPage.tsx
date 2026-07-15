import { useEffect, useRef, useState } from "react";

import type { ApiClient } from "../api/client";
import type { ApiFailure, ReviewReport, SessionView } from "../api/types";

interface ReviewPageProps {
  readonly session: SessionView | null;
  readonly review: ReviewReport | null;
  readonly autoGenerate?: boolean;
  readonly api: ApiClient;
  readonly onReviewUpdated: (review: ReviewReport) => void;
  readonly onRepracticeStarted?: (session: SessionView) => void;
  readonly onError: (error: ApiFailure) => void;
}

const reviewStatusLabels: Record<ReviewReport["status"], string> = {
  pending: "复盘生成中",
  succeeded: "复盘已生成",
  failed: "复盘生成失败"
};

const keyMomentEmptyText = "本次复盘没有提取到足够明确的关键片段。";

const coverageLabel = (coverage: "sufficient" | "insufficient"): string =>
  coverage === "sufficient" ? "本次证据覆盖较好" : "本次证据覆盖不足";

const confidenceLabel = (confidence: "high" | "medium" | "low"): string => {
  if (confidence === "high") {
    return "高";
  }
  if (confidence === "medium") {
    return "中";
  }
  return "低";
};

const shortSampleCopy = (answerCount: number): string | null =>
  answerCount <= 3
    ? `样本较短：当前仅基于 ${answerCount} 条回答，只能反映本轮演练中的可观察表现，不代表稳定能力判断。`
    : null;

const negativeObservationPattern =
  /证据不足|证据有限|跑题|矛盾|不足|缺少|没有|不够|无法|失败|样本|低可信|偏离|未能|缺乏|回避|转移|空泛|泛泛|低于预期|不充分|未提供|未说明|未展示|未回应|未提出|重复|复读|仍以|不满|悬而未决|缺失|薄弱/u;

const isPositiveObservation = (text: string): boolean =>
  text.trim().length > 0 && !negativeObservationPattern.test(text);

export function ReviewPage({ session, review, autoGenerate = false, api, onReviewUpdated, onRepracticeStarted, onError }: ReviewPageProps) {
  const [isCreatingReview, setIsCreatingReview] = useState(false);
  const autoGenerateRef = useRef<string | null>(null);
  const shortSampleMessage = review?.status === "succeeded" && review.evidence_summary !== undefined
    ? shortSampleCopy(review.evidence_summary.answer_count)
    : null;
  const dimensionObservations = review?.status === "succeeded"
    ? (review.dimensions ?? []).map((dimension, index) => ({
        key: `dimension-${index}-${dimension.name}`,
        text: `${dimension.name}：${dimension.conclusion}`
      }))
    : [];
  const positiveObservations = dimensionObservations.filter((item) => isPositiveObservation(item.text));
  const reportImprovements = review?.status === "succeeded"
    ? (review.recommendations ?? []).map((item, index) => ({
        key: `recommendation-${index}-${item.text}`,
        text: item.text,
        uncertainty: item.uncertainty_note
      }))
    : [];
  const heroSummary = review?.status === "succeeded" && review.summary !== undefined
    ? review.summary
    : review === null
      ? "完成演练后，PersonalFlow 会基于真实对话证据生成复盘。"
      : reviewStatusLabels[review.status];
  const heroEvidenceSummary = review?.status === "succeeded" && review.evidence_summary !== undefined
    ? `基于 ${review.evidence_summary.answer_count} 条回答 · 引用 ${review.evidence_summary.cited_answer_count} 条回答 · 置信度 ${confidenceLabel(review.evidence_summary.confidence)}`
    : "等待可用证据";

  const createReview = async () => {
    if (session === null) {
      onError({ code: "validation_error", message: "请先完成一次演练。" });
      return;
    }
    setIsCreatingReview(true);
    const result = await api.createReview(session.id, `review-${session.id}`);
    setIsCreatingReview(false);
    if (!result.ok || result.data === undefined) {
      onError(result.error ?? { code: "api_error", message: "复盘生成失败，请确认演练已结束。" });
      return;
    }
    onReviewUpdated(result.data.review);
  };

  const retry = async () => {
    if (review === null) {
      return;
    }
    const result = await api.retryReview(review.id, `review-retry-${review.id}-${Date.now()}`);
    if (!result.ok || result.data === undefined) {
      onError(result.error ?? { code: "api_error", message: "重新生成复盘失败。" });
      return;
    }
    onReviewUpdated(result.data.review);
  };

  const repractice = async () => {
    if (review === null) {
      return;
    }
    const result = await api.repracticeReview(review.id, `repractice-${review.id}-${Date.now()}`);
    if (!result.ok || result.data === undefined) {
      onError(result.error ?? { code: "api_error", message: "重新练习创建失败，请稍后重试。" });
      return;
    }
    onRepracticeStarted?.(result.data.session);
  };

  useEffect(() => {
    if (!autoGenerate || review !== null || session === null) {
      return;
    }
    if (autoGenerateRef.current === session.id) {
      return;
    }
    autoGenerateRef.current = session.id;
    void createReview();
  }, [autoGenerate, review, session]);

  return (
    <section className="review-page">
      <header className="review-hero">
        <div className="review-hero__copy">
          <p className="eyebrow">复盘报告</p>
          <h2>复盘报告</h2>
          <p>{heroSummary}</p>
        </div>
        <div className="review-hero__meta" aria-label="证据摘要">
          <span>证据摘要</span>
          <strong>{heroEvidenceSummary}</strong>
        </div>
      </header>
      {review === null && autoGenerate ? (
        <p role="status" className="inline-status">正在生成复盘，请稍候。长对话复盘可能需要更久，系统正在整理证据；不要关闭页面。</p>
      ) : null}
      {review === null && !autoGenerate ? <button type="button" className="primary-action" onClick={createReview} disabled={session === null || isCreatingReview}>生成复盘</button> : null}
      {review === null && !autoGenerate ? <p>尚未生成复盘。</p> : null}
      {review === null ? null : (
        <article className="review-report">
          <div className="review-summary-grid">
            <section className="review-card">
              <p>复盘进度：{reviewStatusLabels[review.status]}</p>
              {review.status === "failed" ? <p>失败原因：{review.error_message}<button type="button" onClick={retry}>重新生成</button></p> : null}
              {review.status === "pending" ? <p>复盘仍在处理中。长对话会先抽取证据再生成总结，可稍后刷新查看。</p> : null}
            </section>
            {review.status === "succeeded" ? (
              <section className="review-card">
                <h3>本轮总结</h3>
                <p>{review.summary}</p>
                <button type="button" className="secondary-action" onClick={repractice}>重新练习</button>
              </section>
            ) : null}
            {review.status === "succeeded" && review.evidence_summary !== undefined ? (
              <section aria-label="复盘可信度" className="review-card review-confidence-card">
                <h3>证据覆盖</h3>
                <p>
                  基于 {review.evidence_summary.answer_count} 条回答生成 · 引用 {review.evidence_summary.cited_answer_count} 条回答 · {coverageLabel(review.evidence_summary.coverage)} · 结论置信度：{confidenceLabel(review.evidence_summary.confidence)}
                </p>
                {shortSampleMessage === null ? null : <p>{shortSampleMessage}</p>}
              </section>
            ) : null}
            {review.status === "succeeded" && (review.credibility_checks ?? []).length > 0 ? (
              <section aria-label="稳定检查" className="review-card">
                <h3>稳定检查</h3>
                <ul className="compact-list">{(review.credibility_checks ?? []).map((check, index) => <li key={`${check.kind}-${index}`}>{check.message}</li>)}</ul>
              </section>
            ) : null}
          </div>

          {review.status === "succeeded" ? (
            <div className="review-section-grid">
              <section className="review-card">
                <h3>做得好的地方</h3>
                {positiveObservations.length > 0 ? (
                  <ul className="compact-list">{positiveObservations.map((item) => <li key={`positive-${item.key}`}>{item.text}</li>)}</ul>
                ) : <p>本次复盘没有提取到足够明确的正向观察。</p>}
              </section>
              <section className="review-card">
                <h3>本轮观察</h3>
                {dimensionObservations.length > 0 ? (
                  <ul className="compact-list">{dimensionObservations.map((item) => <li key={item.key}>{item.text}</li>)}</ul>
                ) : <p>本次复盘没有生成明确的维度观察。</p>}
              </section>
              <section className="review-card">
                <h3>关键片段</h3>
                {(review.key_moments ?? []).length > 0 ? (
                  <ul className="moment-list">
                    {(review.key_moments ?? []).map((moment, index) => (
                      <li key={`${moment.title}-${index}`} className="review-moment-card">
                        <strong>{moment.title}</strong>
                        <p>{moment.description}</p>
                        {moment.evidence_locator === undefined ? null : (
                          <p>对应片段：对话片段 {moment.evidence_locator.sequence} · {moment.evidence_locator.speaker}：{moment.evidence_locator.snippet}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : <p>{keyMomentEmptyText}</p>}
              </section>
              <section className="review-card">
                <h3>可以更好的地方</h3>
                {reportImprovements.length > 0 ? (
                  <ul className="recommendation-list">
                    {reportImprovements.map((item) => (
                      <li key={item.key} className="review-recommendation-card">
                        {item.text}
                        {item.uncertainty === undefined ? null : <p>不确定性：{item.uncertainty}</p>}
                      </li>
                    ))}
                  </ul>
                ) : <p>本次复盘没有生成明确的下一步建议。</p>}
              </section>
              {(review.uncertainty_notes ?? []).length === 0 ? null : (
                <section aria-label="不确定性说明" className="review-card">
                  <h3>不确定性说明</h3>
                  <ul className="compact-list">{(review.uncertainty_notes ?? []).map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}</ul>
                </section>
              )}
            </div>
          ) : null}
        </article>
      )}
    </section>
  );
}
