import type { ProductActivity } from "@/lib/domain/products/activity";

function dateLabel(at: string, compact: boolean): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", ...(compact ? {} : { year: "numeric" as const }), month: "2-digit", day: "2-digit",
  }).format(new Date(at)).replace(/\. ?/g, ".").replace(/\.$/, "");
}
function timeLabel(at: string): string {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
}
function fullLabel(at: string): string {
  return `${dateLabel(at, false)} ${timeLabel(at)} KST`;
}

/** 수집되지 않은 값은 숨기고, 실제로 확인한 빈 집계만 0회로 표시한다. */
export function ProductActivityRow({ activity, compact = false }: { activity?: ProductActivity; compact?: boolean }) {
  if (!activity || (!activity.updatedAt && !activity.pushedAt && activity.pushCount === null)) return null;
  return (
    <dl className="card-activity">
      {activity.updatedAt && <div><dt>최근 업데이트</dt><dd><time dateTime={activity.updatedAt} title={fullLabel(activity.updatedAt)}>{dateLabel(activity.updatedAt, compact)}</time></dd></div>}
      {activity.pushedAt && <div><dt>최근 푸시</dt><dd><time dateTime={activity.pushedAt} title={fullLabel(activity.pushedAt)}>{dateLabel(activity.pushedAt, compact)} <span>{timeLabel(activity.pushedAt)} KST</span></time></dd></div>}
      {activity.pushCount !== null && activity.pushObservedAt && <div><dt>7일 푸시</dt><dd title={`${fullLabel(activity.pushObservedAt)} 확인 · 이전 7일의 푸시`}>{activity.pushCount.toLocaleString("ko-KR")}회</dd></div>}
    </dl>
  );
}
