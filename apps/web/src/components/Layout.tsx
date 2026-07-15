import type { ReactNode } from "react";

import type { ApiFailure, SessionView } from "../api/types";

export type PageKey = "home" | "settings" | "materials" | "sceneManagement" | "scenarioBuilder" | "template" | "scene" | "session" | "history" | "review" | "importExport" | "debug";

interface LayoutProps {
  readonly currentPage: PageKey;
  readonly session: SessionView | null;
  readonly error: ApiFailure | null;
  readonly onNavigate: (page: PageKey) => void;
  readonly children: ReactNode;
}

const primaryNav: Array<{ readonly page: PageKey; readonly label: string }> = [
  { page: "home", label: "工作台" },
  { page: "template", label: "模板库" },
  { page: "sceneManagement", label: "我的场景" },
  { page: "history", label: "复盘记录" }
];

const secondaryNav: Array<{ readonly page: PageKey; readonly label: string }> = [
  { page: "materials", label: "材料" },
  { page: "settings", label: "设置" }
];

const sessionStatusLabels: Record<SessionView["status"], string> = {
  running: "演练进行中",
  paused: "演练已暂停",
  completed: "演练已完成",
  ended: "演练已结束",
  failed: "演练失败",
  blocked: "演练已阻断"
};

const pageCopy: Record<PageKey, { readonly title: string; readonly subtitle: string }> = {
  home: { title: "工作台", subtitle: "继续你的演练，或从模板开一场新的对话" },
  settings: { title: "设置", subtitle: "管理模型连接和本地工作室偏好" },
  materials: { title: "材料", subtitle: "整理演练前需要引用的背景信息" },
  sceneManagement: { title: "我的场景", subtitle: "管理已创建的演练场景和草稿" },
  scenarioBuilder: { title: "复杂场景", subtitle: "组合多角色、多阶段的演练流程" },
  template: { title: "模板库", subtitle: "从经过整理的模板开始新的演练" },
  scene: { title: "场景确认", subtitle: "确认场景信息后进入演练" },
  session: { title: "演练中", subtitle: "专注当前对话，保留过程证据" },
  history: { title: "复盘记录", subtitle: "回看历史演练和生成的复盘" },
  review: { title: "复盘报告", subtitle: "基于真实对话证据整理下一步建议" },
  importExport: { title: "单场景导入导出", subtitle: "只处理当前场景的数据迁移" },
  debug: { title: "诊断", subtitle: "查看本地调试辅助信息" }
};

export function Layout({ currentPage, session, error, onNavigate, children }: LayoutProps) {
  const currentPageCopy = pageCopy[currentPage];
  const showSessionStatus = currentPage === "session" && session !== null;

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">PF</span>
          <div>
            <p className="brand-title">PersonalFlow</p>
            <p className="brand-subtitle">本地演练工作室</p>
          </div>
        </div>

        <nav aria-label="PersonalFlow 主导航" className="app-nav">
          {primaryNav.map(({ page, label }) => (
            <button
              key={page}
              type="button"
              className={`nav-pill${page === currentPage ? " nav-pill--active" : ""}`}
              onClick={() => onNavigate(page)}
              aria-current={page === currentPage ? "page" : undefined}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebar-secondary">
          <p className="sidebar-section-label">系统</p>
          <nav aria-label="系统导航" className="app-nav app-nav--secondary">
            {secondaryNav.map(({ page, label }) => (
              <button
                key={page}
                type="button"
                className={`nav-pill${page === currentPage ? " nav-pill--active" : ""}`}
                onClick={() => onNavigate(page)}
                aria-current={page === currentPage ? "page" : undefined}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>

        <section className="sidebar-local-status" aria-label="本地数据">
          <p className="sidebar-local-title">本地数据</p>
          <p className="sidebar-local-copy">数据全部保存在本地</p>
          <p className="sidebar-local-sync"><span aria-hidden="true" />仅本地保存</p>
        </section>
      </aside>

      <main className="app-content-shell">
        <header className="app-header">
          <div className="app-header-copy">
            <h1 className="app-page-title">{currentPageCopy.title}</h1>
            <p className="app-page-subtitle">{currentPageCopy.subtitle}</p>
          </div>
          <div className="app-header-tools">
            <span className="app-header-local-chip">本地工作室</span>
            <button type="button" className="primary-action app-header-primary" onClick={() => onNavigate("template")}>新建演练</button>
            {showSessionStatus ? (
              <p role="status" aria-live="polite" className={`app-status-badge app-status-badge--${session.status}`}>
                {sessionStatusLabels[session.status]}
              </p>
            ) : null}
            <span className="app-user-avatar" aria-label="当前用户">阿</span>
          </div>
        </header>
        {error === null ? null : (
          <section role="alert" className="app-alert">
            <strong>提示</strong>：{error.message}
          </section>
        )}
        <div className="app-main">{children}</div>
      </main>
    </div>
  );
}
