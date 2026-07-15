import type { SessionTimingView, SessionView } from "../api/types";

export const formatElapsedDuration = ({
  startedAt,
  now
}: {
  readonly startedAt: string;
  readonly now: Date;
}): string => {
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) {
    return "时间未记录";
  }
  const elapsedMs = Math.max(0, now.getTime() - started.getTime());
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes <= 0) {
    return "刚刚开始";
  }
  if (minutes < 60) {
    return `已进行 ${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `已进行 ${hours} 小时` : `已进行 ${hours} 小时 ${rest} 分钟`;
};

const statusLabels: Record<SessionView["status"], string> = {
  running: "演练中",
  paused: "已暂停",
  completed: "已结束",
  ended: "已结束",
  failed: "演练失败",
  blocked: "需处理"
};

export function SessionTimer({
  status,
  timing,
  now = new Date()
}: {
  readonly status: SessionView["status"];
  readonly timing?: SessionTimingView;
  readonly now?: Date;
}) {
  if (timing === undefined) {
    return (
      <section aria-label="演练计时" className="session-timer session-timer--empty">
        <strong>时间准备中</strong>
      </section>
    );
  }

  return (
    <section aria-label="演练计时" className="session-timer">
      <strong>{statusLabels[status]}</strong>
      <span>{formatElapsedDuration({ startedAt: timing.started_at, now })}</span>
      {timing.suggested_duration_label === undefined ? null : <span>{timing.suggested_duration_label}</span>}
    </section>
  );
}
