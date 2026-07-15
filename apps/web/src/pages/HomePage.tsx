import type { RecentReviewSummary, RecentSessionSummary, RecentWorkView, SessionView, TemplateSummary } from "../api/types";

interface HomePageProps {
  readonly templates: TemplateSummary[];
  readonly session: SessionView | null;
  readonly recent: Pick<RecentWorkView, "drafts" | "sessions" | "reviews">;
  readonly recentStatus: "loading" | "ready" | "failed";
  readonly recentError?: string;
  readonly onSelectTemplate: (templateId: string) => void;
  readonly onContinueSession: () => void;
  readonly onOpenRecentDraft: (draftId: string) => void;
  readonly onOpenRecentSession: (sessionId: string) => void;
  readonly onOpenRecentReview: (reviewId: string) => void;
  readonly onGoToImport: () => void;
  readonly onGoToSettings: () => void;
  readonly onGoToMaterials?: () => void;
  readonly onGoToSceneManagement?: () => void;
}

const sessionStatusLabels: Record<RecentSessionSummary["status"], string> = {
  running: "进行中",
  paused: "已暂停",
  completed: "已完成",
  ended: "已结束",
  failed: "演练失败",
  blocked: "运行时已阻断"
};

const reviewStatusLabels: Record<RecentReviewSummary["status"], string> = {
  pending: "复盘生成中",
  succeeded: "复盘已生成",
  failed: "复盘生成失败"
};

const canContinueSession = (status: RecentSessionSummary["status"] | SessionView["status"]): boolean =>
  status === "running" || status === "paused";

const recentSessionActionLabel = (status: RecentSessionSummary["status"]): string =>
  canContinueSession(status) ? "继续演练" : "查看详情";

const clipText = (text: string, maxLength: number): string => {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength).trim()}…`;
};

const compactReviewTitle = (title: string): string => {
  const clipped = clipText(title, 18);
  return clipped.length === 0 ? "演练复盘" : clipped;
};

const reviewHelperText = (): string => "打开复盘查看完整报告。";

const formatUpdatedAt = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "最近更新";
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
};

interface HomeSceneCard {
  readonly key: string;
  readonly title: string;
  readonly badge: string;
  readonly meta: string;
  readonly status: string;
  readonly actionLabel: string;
  readonly kind: "draft" | "session" | "review" | "template";
  readonly onOpen: () => void;
}

const buildHomeSceneCards = ({
  templates,
  recent,
  onSelectTemplate,
  onOpenRecentDraft,
  onOpenRecentSession,
  onOpenRecentReview
}: {
  readonly templates: readonly TemplateSummary[];
  readonly recent: Pick<RecentWorkView, "drafts" | "sessions" | "reviews">;
  readonly onSelectTemplate: (templateId: string) => void;
  readonly onOpenRecentDraft: (draftId: string) => void;
  readonly onOpenRecentSession: (sessionId: string) => void;
  readonly onOpenRecentReview: (reviewId: string) => void;
}): HomeSceneCard[] => {
  const sessionCards = recent.sessions.slice(0, 4).map((recentSession): HomeSceneCard => ({
    key: `session-${recentSession.id}`,
    title: recentSession.title,
    badge: "演练",
    meta: `${recentSession.status_label ?? sessionStatusLabels[recentSession.status]} · ${formatUpdatedAt(recentSession.updated_at)}`,
    status: recentSession.status_label ?? sessionStatusLabels[recentSession.status],
    actionLabel: recentSessionActionLabel(recentSession.status),
    kind: "session",
    onOpen: () => onOpenRecentSession(recentSession.id)
  }));

  const draftCards = recent.drafts.slice(0, 4).map((draft): HomeSceneCard => ({
    key: `draft-${draft.id}`,
    title: draft.title,
    badge: "草稿",
    meta: `草稿 · ${formatUpdatedAt(draft.updated_at)}`,
    status: "草稿",
    actionLabel: "继续编辑",
    kind: "draft",
    onOpen: () => onOpenRecentDraft(draft.id)
  }));

  const reviewCards = recent.reviews.slice(0, 4).map((review): HomeSceneCard => ({
    key: `review-${review.id}`,
    title: compactReviewTitle(review.title),
    badge: "复盘",
    meta: `${reviewStatusLabels[review.status]} · ${formatUpdatedAt(review.updated_at)}`,
    status: reviewStatusLabels[review.status],
    actionLabel: review.status === "succeeded" ? "查看复盘" : "查看状态",
    kind: "review",
    onOpen: () => onOpenRecentReview(review.id)
  }));

  const requiredCards = [
    ...sessionCards.slice(0, 1),
    ...draftCards.slice(0, 1),
    ...reviewCards.slice(0, 1)
  ];
  const templateCards = templates.slice(0, Math.max(0, 4 - requiredCards.length)).map((template): HomeSceneCard => ({
    key: `template-${template.id}`,
    title: template.title,
    badge: "模板",
    meta: template.description,
    status: "可开始",
    actionLabel: "开始演练",
    kind: "template",
    onOpen: () => onSelectTemplate(template.id)
  }));
  const overflowCards = [...sessionCards.slice(1), ...draftCards.slice(1), ...reviewCards.slice(1)];
  const cards = [...requiredCards, ...templateCards, ...overflowCards].slice(0, 4);
  if (cards.length > 0) {
    return cards;
  }

  return templates.slice(0, 4).map((template): HomeSceneCard => ({
    key: `template-${template.id}`,
    title: template.title,
    badge: "模板",
    meta: template.description,
    status: "可开始",
    actionLabel: "开始演练",
    kind: "template",
    onOpen: () => onSelectTemplate(template.id)
  }));
};

function HomeSceneCards({ cards }: { readonly cards: readonly HomeSceneCard[] }) {
  if (cards.length === 0) {
    return (
      <article className="home-scene-card home-empty-card">
        <span className="home-scene-badge">准备中</span>
        <h4>模板正在准备</h4>
        <p>模板列表读取完成后会显示可开始的真实演练场景。</p>
        <p>还没有草稿，可以从模板开始创建。</p>
      </article>
    );
  }

  return (
    <div className="home-recent-grid">
      {cards.map((card) => (
        <article key={card.key} className={`home-scene-card${card.kind === "review" ? " recent-review-card" : ""}`}>
          <span className={`home-scene-badge home-scene-badge--${card.kind}`}>{card.badge}</span>
          <h4 className="recent-review-title">{card.title}</h4>
          <p>{card.meta}</p>
          {card.kind === "review" ? <p className="recent-review-summary">{reviewHelperText()}</p> : null}
          <div className="home-scene-card__footer">
            <span>{card.status}</span>
            <button type="button" className="home-card-link" onClick={card.onOpen}>{card.actionLabel}</button>
          </div>
        </article>
      ))}
    </div>
  );
}

export function HomePage({
  templates,
  session,
  recent,
  recentStatus,
  recentError,
  onSelectTemplate,
  onContinueSession,
  onOpenRecentDraft,
  onOpenRecentSession,
  onOpenRecentReview,
  onGoToImport,
  onGoToSettings,
  onGoToMaterials,
  onGoToSceneManagement
}: HomePageProps) {
  const primaryTemplate = templates[0];
  const sceneCards = buildHomeSceneCards({
    templates,
    recent,
    onSelectTemplate,
    onOpenRecentDraft,
    onOpenRecentSession,
    onOpenRecentReview
  });
  const localTotal = recent.drafts.length + recent.sessions.length + recent.reviews.length;
  const sessionWidth = localTotal === 0 ? 0 : Math.round((recent.sessions.length / localTotal) * 100);
  const draftWidth = localTotal === 0 ? 0 : Math.round((recent.drafts.length / localTotal) * 100);
  const reviewWidth = localTotal === 0 ? 0 : Math.round((recent.reviews.length / localTotal) * 100);
  const customScenarioAction = onGoToSceneManagement ?? onGoToImport;

  return (
    <section className="home-page">
      <header className="home-start-band">
        <div className="home-start-band__copy">
          <h2>下午好，继续精进</h2>
          <p>选择一个场景开始演练，AI 会扮演面试官、评委或对手，全程在本地进行。</p>
          <div className="home-stat-chips" aria-label="本地记录概览">
            <span>本地演练 <strong>{recent.sessions.length}</strong> 场</span>
            <span>草稿 <strong>{recent.drafts.length}</strong> 个</span>
            <span>复盘 <strong>{recent.reviews.length}</strong> 份</span>
          </div>
        </div>
        <div className="home-start-band__actions">
          <button type="button" className="primary-action primary-action--light" onClick={() => primaryTemplate === undefined ? undefined : onSelectTemplate(primaryTemplate.id)} disabled={primaryTemplate === undefined}>开始一次演练</button>
          <button type="button" className="secondary-action secondary-action--on-dark" onClick={customScenarioAction}>自定义场景</button>
        </div>
      </header>
      {recentStatus === "loading" ? <p aria-live="polite" className="inline-status">正在读取最近记录...</p> : null}
      {recentStatus === "failed" ? (
        <p role="alert" className="inline-alert">{recentError ?? "最近记录读取失败，请刷新后重试。"}</p>
      ) : null}
      <div className="home-main-grid">
        <section className="home-recent-scenes" aria-label="最近场景">
          <div className="home-section-heading">
            <div>
              <h3>最近场景</h3>
              <p>上次未完成的演练会保留在本地</p>
            </div>
            <button type="button" className="home-card-link" onClick={onGoToSceneManagement ?? onGoToImport}>查看全部</button>
          </div>
          <HomeSceneCards cards={sceneCards} />
        </section>
        <aside className="home-insight-rail" aria-label="本地概览">
          <section className="home-insight-card">
            <div className="home-insight-card__title">
              <h3>本地概览</h3>
              <span>{localTotal}</span>
            </div>
            <div className="home-progress-list">
              <div>
                <div><span>演练记录</span><strong>{recent.sessions.length}</strong></div>
                <meter min={0} max={100} value={sessionWidth}>{sessionWidth}%</meter>
              </div>
              <div>
                <div><span>草稿沉淀</span><strong>{recent.drafts.length}</strong></div>
                <meter min={0} max={100} value={draftWidth}>{draftWidth}%</meter>
              </div>
              <div>
                <div><span>复盘报告</span><strong>{recent.reviews.length}</strong></div>
                <meter min={0} max={100} value={reviewWidth}>{reviewWidth}%</meter>
              </div>
            </div>
            {recent.sessions.length === 0 ? <p className="home-empty-hint">开始演练后会在这里继续。</p> : null}
            {recent.reviews.length === 0 ? <p className="home-empty-hint">完成一次演练后会在这里看到复盘。</p> : null}
          </section>
          <section className="home-tip-card">
            <span aria-hidden="true">?</span>
            <div>
              <h3>复盘提示</h3>
              <p>复盘比练习更重要。每场结束后花 3 分钟查看证据片段和下一步建议。</p>
            </div>
          </section>
          <section className="home-quick-links" aria-label="快捷入口">
            {onGoToMaterials === undefined ? null : <button type="button" className="secondary-action" onClick={onGoToMaterials}>添加材料</button>}
            <button type="button" className="secondary-action" onClick={onGoToImport}>导入场景</button>
            <button type="button" className="secondary-action" onClick={onGoToSettings}>模型设置</button>
          </section>
        </aside>
      </div>
      {session === null || !canContinueSession(session.status) ? null : (
        <aside className="home-resume-card">
          <p>当前页面流程中有未完成演练。</p>
          <button type="button" className="primary-action" onClick={onContinueSession}>继续演练</button>
        </aside>
      )}
    </section>
  );
}
