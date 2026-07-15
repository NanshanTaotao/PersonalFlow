export interface VisibleTranscriptEntry {
  readonly id: string;
  readonly eventId?: string;
  readonly sequence?: number;
  readonly actorKind: "user" | "ai" | "system";
  readonly actorName: string;
  readonly text: string;
  readonly [safeOrIgnoredField: string]: unknown;
}

export function SessionTranscript({
  entries,
  emptyMessage = "当前还没有可见发言，可以先让 AI 提问或提交回答。",
  disabled = false,
  onFork,
  onWithdraw
}: {
  readonly entries: VisibleTranscriptEntry[];
  readonly emptyMessage?: string;
  readonly disabled?: boolean;
  readonly onFork?: (entry: VisibleTranscriptEntry) => void;
  readonly onWithdraw?: (entry: VisibleTranscriptEntry) => void;
}) {
  const visibleActionCount = 4;

  return (
    <section aria-label="演练对话" className="transcript-card chat-transcript-card">
      <h2>演练对话</h2>
      {entries.length === 0 ? <p>{emptyMessage}</p> : null}
      <ol className="chat-thread">
        {entries.map((entry, index) => {
          const isQuietAction = entries.length > visibleActionCount && index < entries.length - visibleActionCount;
          const actionLabel = entry.sequence === undefined ? `${entry.actorName}操作` : `第 ${entry.sequence} 轮操作`;
          const forkLabel = entry.sequence === undefined ? `从${entry.actorName}发言分支` : `从第 ${entry.sequence} 轮分支`;
          const withdrawLabel = entry.sequence === undefined ? `撤回${entry.actorName}发言并重写` : `撤回第 ${entry.sequence} 轮并重写`;
          return (
            <li key={entry.id} className={`chat-message chat-message--${entry.actorKind}`}>
              <span className="chat-avatar" aria-hidden="true">{entry.actorKind === "user" ? "你" : entry.actorKind === "ai" ? "AI" : "系"}</span>
              <div className="chat-message__body">
                <div className="chat-message__meta">
                  <strong>{entry.actorName}</strong>
                  {entry.sequence === undefined ? null : <span>第 {entry.sequence} 轮</span>}
                </div>
                <div className="chat-bubble">{entry.text}</div>
                <div className={`chat-message__actions${isQuietAction ? " chat-message__actions--quiet" : ""}`} aria-label={actionLabel}>
                  {entry.eventId === undefined || onFork === undefined ? null : (
                    <button type="button" className="small-action" aria-label={forkLabel} disabled={disabled} onClick={() => onFork(entry)}>从这里分支</button>
                  )}
                  {entry.eventId === undefined || entry.actorKind !== "user" || onWithdraw === undefined ? null : (
                    <button type="button" className="small-action" aria-label={withdrawLabel} disabled={disabled} onClick={() => onWithdraw(entry)}>撤回并重写</button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
