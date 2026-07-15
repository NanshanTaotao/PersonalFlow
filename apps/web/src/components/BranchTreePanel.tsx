import type { BranchTreeNodeView, BranchTreeView } from "../api/types";

interface BranchTreePanelProps {
  readonly tree: BranchTreeView | null;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onCreateReview?: (sessionId: string) => void;
}

const statusLabel = (status: BranchTreeNodeView["status"]): string => {
  const labels: Record<BranchTreeNodeView["status"], string> = {
    running: "进行中",
    paused: "已暂停",
    completed: "已完成",
    ended: "已结束",
    failed: "失败",
    blocked: "已阻断"
  };
  return labels[status];
};

const canCreateReview = (status: BranchTreeNodeView["status"]): boolean =>
  status === "completed" || status === "ended";

const openActionLabel = (status: BranchTreeNodeView["status"]): string =>
  status === "running" || status === "paused" ? "切换继续" : "查看版本";

function BranchNode({
  node,
  onOpenSession,
  onCreateReview
}: {
  readonly node: BranchTreeNodeView;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onCreateReview?: (sessionId: string) => void;
}) {
  return (
    <li className={`branch-node${node.is_current ? " branch-node--current" : ""}`} aria-current={node.is_current ? "true" : undefined}>
      <div className="branch-node-summary branch-node__summary">
        <div className="branch-node__title-row">
          <strong>{node.label}</strong>
          {node.is_current ? <span className="branch-node__current-label">当前版本</span> : null}
        </div>
        <div className="branch-node__meta">
          <span>{statusLabel(node.status)}</span>
          <span>{node.rounds} 轮</span>
          {node.forked_from_sequence === undefined ? null : <span>从第 {node.forked_from_sequence} 轮分出</span>}
        </div>
      </div>
      {node.latest_review === undefined ? null : <p className="branch-node__review">已生成复盘：{node.latest_review.title}</p>}
      <div className="branch-node-actions">
        <button type="button" className="small-action" onClick={() => onOpenSession(node.session_id)}>
          {openActionLabel(node.status)}
        </button>
        {canCreateReview(node.status) && onCreateReview !== undefined
          ? <button type="button" className="small-action" onClick={() => onCreateReview(node.session_id)}>生成复盘</button>
          : null}
      </div>
      {node.children.length === 0 ? null : (
        <ul className="branch-tree-list branch-tree-list--nested">
          {node.children.map((child) => (
            <BranchNode
              key={child.session_id}
              node={child}
              onOpenSession={onOpenSession}
              {...(onCreateReview === undefined ? {} : { onCreateReview })}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function BranchTreePanel({ tree, onOpenSession, onCreateReview }: BranchTreePanelProps) {
  if (tree === null) {
    return null;
  }
  return (
    <section aria-label="版本历史" className="branch-tree-card">
      <div className="branch-tree-card__header">
        <h3>版本历史</h3>
        <p>保留每次分支和撤回后的演练版本。</p>
      </div>
      <ul className="branch-tree-list">
        {tree.nodes.map((node) => (
          <BranchNode
            key={node.session_id}
            node={node}
            onOpenSession={onOpenSession}
            {...(onCreateReview === undefined ? {} : { onCreateReview })}
          />
        ))}
      </ul>
    </section>
  );
}
