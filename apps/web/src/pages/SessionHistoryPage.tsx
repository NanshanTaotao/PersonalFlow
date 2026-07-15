import { useEffect, useState } from "react";

import type { BranchTreeView, RecentReviewSummary, RecentSessionSummary, SessionHistoryView } from "../api/types";
import { BranchTreePanel } from "../components/BranchTreePanel";

interface SessionHistoryPageProps {
  readonly history: SessionHistoryView | null;
  readonly status: "loading" | "ready" | "failed";
  readonly error: string;
  readonly archive?: {
    readonly sessions: readonly RecentSessionSummary[];
    readonly reviews: readonly RecentReviewSummary[];
  };
  readonly onOpenReview: (reviewId: string) => void;
  readonly onOpenSessionArchive?: (sessionId: string) => void;
  readonly onCreateReview?: () => void;
  readonly onContinue?: () => void;
  readonly branchTree?: BranchTreeView | null;
  readonly onOpenBranch?: (sessionId: string) => void;
  readonly onCreateBranchReview?: (sessionId: string) => void;
  readonly onRepractice: () => void;
}

const formatDateTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "时间未记录";
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
};

const canCreateReview = (status: SessionHistoryView["status"]): boolean => status === "completed" || status === "ended";

const compactArchiveTitle = (title: string): string => {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return "复盘记录";
  }
  return trimmed.length <= 24 ? trimmed : `${trimmed.slice(0, 24).trim()}...`;
};

const reviewStatusLabels: Record<RecentReviewSummary["status"], string> = {
  pending: "复盘生成中",
  succeeded: "复盘已完成",
  failed: "复盘生成失败"
};

const sessionStatusLabels: Record<RecentSessionSummary["status"], string> = {
  running: "演练进行中",
  paused: "演练已暂停",
  completed: "已完成",
  ended: "已结束",
  failed: "演练失败",
  blocked: "演练已阻断"
};

const reviewArchivePageSize = 6;
const practiceArchivePageSize = 3;

const totalPages = (itemCount: number, pageSize: number): number => Math.max(1, Math.ceil(itemCount / pageSize));
const clampPage = (page: number, pageCount: number): number => Math.min(Math.max(1, page), pageCount);
const pageItems = <T,>(items: readonly T[], page: number, pageSize: number): readonly T[] => {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
};

interface PaginationControlsProps {
  readonly label: string;
  readonly totalItems: number;
  readonly page: number;
  readonly pageSize: number;
  readonly onPageChange: (page: number) => void;
}

function PaginationControls({ label, totalItems, page, pageSize, onPageChange }: PaginationControlsProps) {
  const pageCount = totalPages(totalItems, pageSize);
  if (pageCount <= 1) {
    return null;
  }
  const currentPage = clampPage(page, pageCount);
  return (
    <nav className="pagination-controls" aria-label={`${label}分页`}>
      <button type="button" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage <= 1}>上一页</button>
      <span>第 {currentPage} / {pageCount} 页 · 共 {totalItems} 项</span>
      <button type="button" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= pageCount}>下一页</button>
    </nav>
  );
}

export function SessionHistoryPage({
  history,
  status,
  error,
  archive,
  onOpenReview,
  onOpenSessionArchive,
  onCreateReview,
  onContinue,
  branchTree,
  onOpenBranch,
  onCreateBranchReview,
  onRepractice
}: SessionHistoryPageProps) {
  const [reviewArchivePage, setReviewArchivePage] = useState(1);
  const [practiceArchivePage, setPracticeArchivePage] = useState(1);
  const archiveReviews = archive?.reviews ?? [];
  const archiveSessions = archive?.sessions ?? [];
  const reviewedSessionIds = new Set(archiveReviews.map((review) => review.session_id));
  const sessionsWithoutReview = archiveSessions.filter((session) => !reviewedSessionIds.has(session.id));
  const reviewArchivePageCount = totalPages(archiveReviews.length, reviewArchivePageSize);
  const practiceArchivePageCount = totalPages(sessionsWithoutReview.length, practiceArchivePageSize);
  const currentReviewArchivePage = clampPage(reviewArchivePage, reviewArchivePageCount);
  const currentPracticeArchivePage = clampPage(practiceArchivePage, practiceArchivePageCount);

  useEffect(() => {
    setReviewArchivePage((page) => clampPage(page, reviewArchivePageCount));
  }, [reviewArchivePageCount]);

  useEffect(() => {
    setPracticeArchivePage((page) => clampPage(page, practiceArchivePageCount));
  }, [practiceArchivePageCount]);

  if (status === "loading") {
    return <p aria-live="polite">正在读取练习档案...</p>;
  }
  if (status === "failed") {
    return <p role="alert">{error === "" ? "练习档案读取失败，请返回首页重试。" : error}</p>;
  }
  if (history === null) {
    if (archive === undefined) {
      return <p>请选择一条历史演练。</p>;
    }

    const sessionsById = new Map(archive.sessions.map((session) => [session.id, session]));
    const visibleReviews = pageItems(archive.reviews, currentReviewArchivePage, reviewArchivePageSize);
    const visibleSessionsWithoutReview = pageItems(sessionsWithoutReview, currentPracticeArchivePage, practiceArchivePageSize);

    return (
      <section className="review-archive-page">
        <header className="review-archive-summary">
          <div>
            <p className="eyebrow">复盘档案</p>
            <h2>复盘记录</h2>
            <p>按最近更新时间整理已生成的复盘，并保留关联练习入口。</p>
          </div>
          <p>{archive.reviews.length} 份复盘 · {archive.sessions.length} 场练习</p>
        </header>

        {archive.reviews.length === 0 ? (
          <article className="review-archive-card">
            <div>
              <p className="eyebrow">暂无复盘</p>
              <h3>还没有复盘记录</h3>
              <p>完成一次练习并生成复盘后，会在这里集中回看。</p>
            </div>
            <div className="control-row control-row--start">
              <button type="button" onClick={onRepractice}>去我的场景</button>
            </div>
          </article>
        ) : (
          <>
            <div className="review-archive-grid">
              {visibleReviews.map((review) => {
                const relatedSession = sessionsById.get(review.session_id);
                const relatedSessionStatus = relatedSession?.status_label ?? (relatedSession === undefined ? null : sessionStatusLabels[relatedSession.status]);

                return (
                  <article className="review-archive-card" key={review.id}>
                    <div>
                      <p className="eyebrow">{formatDateTime(review.updated_at)} · {reviewStatusLabels[review.status]}</p>
                      <h3>{compactArchiveTitle(review.title)}</h3>
                      <p>
                        {relatedSession === undefined
                          ? "关联练习已保存，可从这里打开。"
                          : `关联练习：${relatedSession.title}${relatedSessionStatus === null ? "" : ` · ${relatedSessionStatus}`}`}
                      </p>
                    </div>
                    <div className="control-row control-row--start">
                      <button type="button" aria-label={`查看 ${review.title}`} onClick={() => onOpenReview(review.id)}>查看复盘</button>
                      {onOpenSessionArchive === undefined ? null : (
                        <button
                          type="button"
                          aria-label={relatedSession === undefined ? "查看关联练习" : `查看 ${relatedSession.title} 的关联练习`}
                          onClick={() => onOpenSessionArchive(review.session_id)}
                        >
                          查看关联练习
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            <PaginationControls label="复盘记录" totalItems={archive.reviews.length} page={currentReviewArchivePage} pageSize={reviewArchivePageSize} onPageChange={setReviewArchivePage} />
          </>
        )}

        {sessionsWithoutReview.length === 0 ? null : (
          <section className="review-archive-summary" aria-label="尚未生成复盘的练习">
            <div>
              <p className="eyebrow">练习档案</p>
              <h3>尚未生成复盘的练习</h3>
              <p>这些练习已有历史档案，可以先回看对话再生成复盘。</p>
            </div>
            <div className="review-archive-grid">
              {visibleSessionsWithoutReview.map((session) => (
                <article className="review-archive-card" key={session.id}>
                  <div>
                    <p className="eyebrow">{formatDateTime(session.updated_at)} · {session.status_label ?? sessionStatusLabels[session.status]}</p>
                    <h3>{session.title}</h3>
                  </div>
                  {onOpenSessionArchive === undefined ? null : (
                    <div className="control-row control-row--start">
                      <button type="button" aria-label={`查看 ${session.title} 的练习档案`} onClick={() => onOpenSessionArchive(session.id)}>查看练习档案</button>
                    </div>
                  )}
                </article>
              ))}
            </div>
            <PaginationControls label="尚未生成复盘的练习" totalItems={sessionsWithoutReview.length} page={currentPracticeArchivePage} pageSize={practiceArchivePageSize} onPageChange={setPracticeArchivePage} />
          </section>
        )}
      </section>
    );
  }
  return (
    <section className="history-page">
      <header className="history-hero">
        <div>
          <p className="eyebrow">练习档案</p>
          <h2>练习档案</h2>
          <p>{history.title} · {history.status_label ?? history.status} · {history.rounds} 轮对话</p>
          <p>
            {formatDateTime(history.created_at)} - {formatDateTime(history.updated_at)}
            {" · "}
            {history.model_summary.label}
            {" · "}
            {history.scene.archived ? "已归档场景" : "可继续使用的场景"}
          </p>
        </div>
        <div className="control-row">
          {history.status === "running" || history.status === "paused" ? <button type="button" onClick={onContinue}>继续演练</button> : null}
          <button type="button" onClick={onRepractice}>重新练习</button>
        </div>
      </header>
      <div className="history-content-grid">
        <div className="history-main">
          <section aria-label="完整对话" className="history-card history-transcript-card">
            <h3>完整对话</h3>
            {history.transcript.length === 0 ? <p>这次练习还没有可回看的对话。</p> : (
              <ol className="history-transcript-list">
                {history.transcript.map((entry) => (
                  <li key={`${entry.sequence}-${entry.speaker}`}>
                    <strong>{entry.speaker}</strong>
                    <p>{entry.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label="关联复盘" className="history-card">
            <h3>关联复盘</h3>
            {history.reviews.length === 0 ? (
              <>
                <p>这次练习还没有生成复盘。</p>
                {canCreateReview(history.status) && onCreateReview !== undefined
                  ? <button type="button" onClick={onCreateReview}>生成复盘</button>
                  : null}
              </>
            ) : (
              <ul className="history-review-list">
                {history.reviews.map((review) => (
                  <li key={`${review.title}-${review.status}`}>
                    <strong>{review.title}</strong>
                    <span> · {review.status_label ?? review.status}</span>
                    <button type="button" onClick={() => onOpenReview(review.id)}>查看关联复盘</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside className="history-side">
          <BranchTreePanel
            tree={branchTree ?? null}
            onOpenSession={(sessionId) => onOpenBranch?.(sessionId)}
            onCreateReview={(sessionId) => onCreateBranchReview?.(sessionId)}
          />
        </aside>
      </div>
    </section>
  );
}
