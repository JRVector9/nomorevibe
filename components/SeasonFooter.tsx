import Link from "next/link";
import { RANKING_STALE_MS, type SeasonSummary } from "@/lib/domain/ranking/view";

/**
 * 푸터의 시즌 한 줄.
 *
 * 현재 시즌이 언제부터 언제까지이고, 경계가 처리됐는지, 공개 순위 스냅샷이 얼마나 묵었는지.
 * 목록을 보는 동안 필요한 정보가 아니라 "지금 어떤 규칙으로 세고 있나"를 확인할 때 찾는
 * 것이라 푸터에 둔다. 카드가 아니라 푸터 글자 크기(13px)로 맞춘다.
 */
const KST_DATE_TIME = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function remainingTime(endsAt: Date, now: Date): string {
  const milliseconds = endsAt.getTime() - now.getTime();
  if (milliseconds <= 0) return "경계 처리 대기";
  const hours = Math.ceil(milliseconds / 3_600_000);
  if (hours < 24) return `${hours}시간 남음`;
  return `${Math.ceil(hours / 24)}일 남음`;
}

function snapshotAge(refreshedAt: Date | null, now: Date): string {
  if (!refreshedAt) return "스냅샷 집계 대기";
  const age = Math.max(0, now.getTime() - refreshedAt.getTime());
  const minutes = Math.floor(age / 60_000);
  const label = minutes < 1 ? "방금" : minutes < 60 ? `${minutes}분 전` : `${Math.floor(minutes / 60)}시간 전`;
  return `스냅샷 ${label}${age > RANKING_STALE_MS ? " · 오래됨" : ""}`;
}

export function SeasonFooter({
  season,
  latestClosed,
  now,
}: {
  season: SeasonSummary;
  latestClosed: SeasonSummary | null;
  now: Date;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-4">
      <span className="font-mono font-bold text-fg">{season.key}</span>
      <span className="text-fg-2">
        {KST_DATE_TIME.format(season.startsAt)} – {KST_DATE_TIME.format(season.endsAt)} KST
      </span>
      <span className="font-semibold text-accent">{remainingTime(season.endsAt, now)}</span>
      <span>{snapshotAge(season.refreshedAt, now)}</span>
      <div className="ml-auto flex gap-3 font-semibold">
        <Link href={`/rankings/${season.key}`} className="text-accent hover:underline">현재 규칙 보기</Link>
        {latestClosed && (
          <Link href={`/rankings/${latestClosed.key}`} className="text-fg-2 hover:text-fg">지난 시즌</Link>
        )}
      </div>
    </div>
  );
}
