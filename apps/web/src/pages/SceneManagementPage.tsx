import { useEffect, useMemo, useState } from "react";

import type { ApiClient } from "../api/client";
import type { ApiFailure, RecentWorkView, SceneArchiveSummary } from "../api/types";

interface SceneManagementPageProps {
  readonly recent: RecentWorkView;
  readonly archive?: SceneArchiveSummary[];
  readonly status: "loading" | "ready" | "failed";
  readonly api: ApiClient;
  readonly onOpenDraft: (draftId: string) => void;
  readonly onOpenSessionHistory?: (sessionId: string) => void;
  readonly onOpenReview: (reviewId: string) => void;
  readonly onOpenScenarioBuilder?: () => void;
  readonly onSceneCopied: (draftId: string, message: string) => void;
  readonly onSceneRenamed?: (message: string) => void;
  readonly onSceneDeleted: (message: string) => void;
  readonly onError: (error: ApiFailure) => void;
}

const formatSceneTime = (value: string): string => {
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

const reviewStatusLabel = (status: "pending" | "succeeded" | "failed"): string => {
  if (status === "succeeded") {
    return "复盘已生成";
  }
  if (status === "pending") {
    return "复盘生成中";
  }
  return "复盘生成失败";
};

const sessionStatusLabel = (status: RecentWorkView["sessions"][number]["status"]): string => {
  const labels: Record<RecentWorkView["sessions"][number]["status"], string> = {
    running: "进行中",
    paused: "已暂停",
    completed: "已完成",
    ended: "已结束",
    failed: "演练失败",
    blocked: "已阻断"
  };
  return labels[status];
};

const sceneArchivePageSize = 3;
const sceneSectionPageSize = 3;

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

export function SceneManagementPage({
  recent,
  archive,
  status,
  api,
  onOpenDraft,
  onOpenSessionHistory,
  onOpenReview,
  onOpenScenarioBuilder,
  onSceneCopied,
  onSceneRenamed,
  onSceneDeleted,
  onError
}: SceneManagementPageProps) {
  const [query, setQuery] = useState("");
  const [showArchivedOnly, setShowArchivedOnly] = useState(false);
  const [archivePage, setArchivePage] = useState(1);
  const [confirmedScenesPage, setConfirmedScenesPage] = useState(1);
  const [draftsPage, setDraftsPage] = useState(1);
  const [reviewsPage, setReviewsPage] = useState(1);
  const copyScene = async (sceneId: string) => {
    const result = await api.copyScene(sceneId, `copy-scene-${Date.now()}`);
    if (!result.ok || result.data === undefined) {
      onError(result.error ?? { code: "api_error", message: "复制场景失败，请稍后重试。" });
      return;
    }
    onSceneCopied(result.data.draft.id, "场景副本已创建，可继续编辑草稿。");
  };

  const renameScene = async (sceneId: string, currentTitle: string) => {
    const nextTitle = typeof window === "undefined" ? currentTitle : window.prompt("新的场景名称", currentTitle);
    if (nextTitle === null || nextTitle.trim() === "" || nextTitle.trim() === currentTitle) {
      return;
    }
    const result = await api.renameScene(sceneId, nextTitle.trim(), `rename-scene-${Date.now()}`);
    if (!result.ok || result.data === undefined) {
      onError(result.error ?? { code: "api_error", message: "重命名场景失败，请稍后重试。" });
      return;
    }
    onSceneRenamed?.("场景名称已更新。");
  };

  const deleteScene = async (sceneId: string) => {
    if (typeof window !== "undefined" && !window.confirm("删除场景？历史演练和复盘仍会保留。")) {
      return;
    }
    const result = await api.deleteScene(sceneId, `delete-scene-${Date.now()}`);
    if (!result.ok || result.data === undefined) {
      onError(result.error ?? { code: "api_error", message: "删除场景失败，请稍后重试。" });
      return;
    }
    onSceneDeleted(result.data.message);
  };

  const archiveItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (archive ?? []).filter((scene) => {
      const matchesArchive = !showArchivedOnly || scene.archived;
      const combined = `${scene.title} ${scene.latest_session?.title ?? ""} ${scene.latest_review?.title ?? ""}`.toLowerCase();
      const matchesQuery = keyword === "" || combined.includes(keyword);
      return matchesArchive && matchesQuery;
    });
  }, [archive, query, showArchivedOnly]);
  const archivePageCount = totalPages(archiveItems.length, sceneArchivePageSize);
  const confirmedScenesPageCount = totalPages(recent.scenes.length, sceneSectionPageSize);
  const draftsPageCount = totalPages(recent.drafts.length, sceneSectionPageSize);
  const reviewsPageCount = totalPages(recent.reviews.length, sceneSectionPageSize);
  const currentArchivePage = clampPage(archivePage, archivePageCount);
  const currentConfirmedScenesPage = clampPage(confirmedScenesPage, confirmedScenesPageCount);
  const currentDraftsPage = clampPage(draftsPage, draftsPageCount);
  const currentReviewsPage = clampPage(reviewsPage, reviewsPageCount);
  const visibleArchiveItems = pageItems(archiveItems, currentArchivePage, sceneArchivePageSize);
  const visibleScenes = pageItems(recent.scenes, currentConfirmedScenesPage, sceneSectionPageSize);
  const visibleDrafts = pageItems(recent.drafts, currentDraftsPage, sceneSectionPageSize);
  const visibleReviews = pageItems(recent.reviews, currentReviewsPage, sceneSectionPageSize);

  useEffect(() => {
    setArchivePage(1);
  }, [query, showArchivedOnly]);

  useEffect(() => {
    setArchivePage((page) => clampPage(page, archivePageCount));
  }, [archivePageCount]);

  useEffect(() => {
    setConfirmedScenesPage((page) => clampPage(page, confirmedScenesPageCount));
  }, [confirmedScenesPageCount]);

  useEffect(() => {
    setDraftsPage((page) => clampPage(page, draftsPageCount));
  }, [draftsPageCount]);

  useEffect(() => {
    setReviewsPage((page) => clampPage(page, reviewsPageCount));
  }, [reviewsPageCount]);

  return (
    <section className="scene-management-page">
      <header className="scene-management-hero">
        <div>
          <p className="eyebrow">练习档案库</p>
          <h2>练习档案库</h2>
          <p>在我的场景中管理已确认场景、继续编辑草稿，并从场景维度查看历史演练和复盘。</p>
        </div>
        <div className="scene-management-hero__stats" aria-label="档案概览">
          <span><strong>{archive?.length ?? 0}</strong> 个场景</span>
          <span><strong>{recent.drafts.length}</strong> 个草稿</span>
          <span><strong>{recent.reviews.length}</strong> 份复盘</span>
        </div>
        {onOpenScenarioBuilder === undefined ? null : (
          <button type="button" className="primary-action" onClick={onOpenScenarioBuilder}>创建复杂场景</button>
        )}
      </header>
      {status === "loading" ? <p>正在读取场景...</p> : null}
      {status === "failed" ? <p role="alert">场景读取失败，请刷新后重试。</p> : null}
      {archive === undefined ? null : (
        <section aria-label="场景档案" className="scene-archive-panel">
          <div className="scene-archive-toolbar">
            <div>
              <h3>我的场景</h3>
              <p>按最近更新时间整理确认场景、演练和复盘。</p>
            </div>
            <label className="scene-search-field">
              <span>搜索场景或复盘</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入场景、演练或复盘名称" />
            </label>
            <div className="scene-filter-pills">
              <button type="button" onClick={() => setShowArchivedOnly(false)} aria-pressed={!showArchivedOnly}>全部场景</button>
              <button type="button" onClick={() => setShowArchivedOnly(true)} aria-pressed={showArchivedOnly}>仅看已归档</button>
            </div>
          </div>
          {archiveItems.length === 0 ? <p>没有匹配的场景档案。</p> : (
            <>
              <ul className="scene-archive-grid">
                {visibleArchiveItems.map((scene) => (
                  <li key={scene.id} className="scene-archive-card">
                    <div className="scene-archive-card__header">
                      <span className={`scene-status-chip${scene.archived ? " scene-status-chip--muted" : ""}`}>{scene.archived ? "已归档" : "可练习"}</span>
                      <time dateTime={scene.updated_at}>{formatSceneTime(scene.updated_at)}</time>
                    </div>
                    <strong>{scene.title}</strong>
                    <p>{scene.session_count} 次演练 · {scene.review_count} 份复盘</p>
                    {scene.latest_session === null ? null : (
                      <p>最近演练：{scene.latest_session.title} · {scene.latest_session.status_label ?? sessionStatusLabel(scene.latest_session.status)}</p>
                    )}
                    {scene.latest_review === null ? null : (
                      <p>最近复盘：{scene.latest_review.title} · {reviewStatusLabel(scene.latest_review.status)}</p>
                    )}
                    <div className="scene-card-actions">
                      {scene.latest_session === null || onOpenSessionHistory === undefined ? null : (
                        <button type="button" onClick={() => onOpenSessionHistory(scene.latest_session?.id ?? "")}>查看演练详情</button>
                      )}
                      {scene.latest_review === null ? null : (
                        <button type="button" onClick={() => onOpenReview(scene.latest_review?.id ?? "")}>查看关联复盘</button>
                      )}
                      <button type="button" onClick={() => void renameScene(scene.id, scene.title)}>重命名</button>
                      <button type="button" onClick={() => void copyScene(scene.id)}>复制场景</button>
                      {scene.archived ? null : <button type="button" onClick={() => void deleteScene(scene.id)}>归档场景</button>}
                    </div>
                  </li>
                ))}
              </ul>
              <PaginationControls label="场景档案" totalItems={archiveItems.length} page={currentArchivePage} pageSize={sceneArchivePageSize} onPageChange={setArchivePage} />
            </>
          )}
        </section>
      )}
      <div className="scene-management-grid">
        <section aria-label="已确认场景" className="scene-management-card">
          <h3>已确认场景</h3>
          {recent.scenes.length === 0 ? <p>还没有已确认场景。</p> : (
            <>
              <ul className="scene-mini-list">
                {visibleScenes.map((scene) => (
                  <li key={scene.id}>
                    <div>
                      <strong>{scene.title}</strong>
                      <span>已确认 · {formatSceneTime(scene.updated_at)}</span>
                    </div>
                    <div className="scene-card-actions">
                      <button type="button" onClick={() => void copyScene(scene.id)}>复制场景</button>
                      <button type="button" onClick={() => void deleteScene(scene.id)}>删除场景</button>
                    </div>
                  </li>
                ))}
              </ul>
              <PaginationControls label="已确认场景" totalItems={recent.scenes.length} page={currentConfirmedScenesPage} pageSize={sceneSectionPageSize} onPageChange={setConfirmedScenesPage} />
            </>
          )}
        </section>
        <section aria-label="可继续编辑的草稿" className="scene-management-card">
          <h3>继续编辑草稿</h3>
          {recent.drafts.length === 0 ? <p>暂无可继续编辑的草稿。</p> : (
            <>
              <ul className="scene-mini-list">
                {visibleDrafts.map((draft) => (
                  <li key={draft.id}>
                    <div>
                      <strong>{draft.title}</strong>
                      <span>草稿 · {formatSceneTime(draft.updated_at)}</span>
                    </div>
                    <button type="button" onClick={() => onOpenDraft(draft.id)}>继续编辑草稿</button>
                  </li>
                ))}
              </ul>
              <PaginationControls label="草稿" totalItems={recent.drafts.length} page={currentDraftsPage} pageSize={sceneSectionPageSize} onPageChange={setDraftsPage} />
            </>
          )}
        </section>
        <section aria-label="历史复盘" className="scene-management-card">
          <h3>历史复盘</h3>
          {recent.reviews.length === 0 ? <p>还没有历史复盘。</p> : (
            <>
              <ul className="scene-mini-list">
                {visibleReviews.map((review) => (
                  <li key={review.id}>
                    <div>
                      <strong>{review.title}</strong>
                      <span>{reviewStatusLabel(review.status)} · {formatSceneTime(review.updated_at)}</span>
                    </div>
                    <button type="button" onClick={() => onOpenReview(review.id)}>查看历史复盘</button>
                  </li>
                ))}
              </ul>
              <PaginationControls label="历史复盘" totalItems={recent.reviews.length} page={currentReviewsPage} pageSize={sceneSectionPageSize} onPageChange={setReviewsPage} />
            </>
          )}
        </section>
      </div>
    </section>
  );
}
