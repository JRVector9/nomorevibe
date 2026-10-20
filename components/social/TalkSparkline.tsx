import type { TalkStarGrowth } from "@/lib/social/talk";

/**
 * 글 뒤 GitHub 스타 곡선 — 서버에서 그리는 SVG 한 장(브라우저 JS 없음).
 * 가로는 시각, 세로는 그 구간의 최소~최대 스타. 첫 글 시각이 구간 안이면 점선으로 찍는다.
 */
export function TalkSparkline({ growth, postedAt, label, width = 180, height = 34, className = "talk-spark" }: {
  growth: TalkStarGrowth;
  postedAt?: Date;
  label: string;
  width?: number;
  height?: number;
  className?: string;
}) {
  const points = growth.points;
  if (points.length < 2) return null;
  const start = points[0].at.getTime();
  const span = Math.max(1, points.at(-1)!.at.getTime() - start);
  const low = Math.min(...points.map(point => point.stars));
  const range = Math.max(1, Math.max(...points.map(point => point.stars)) - low);
  const pad = 2;
  const x = (at: number) => pad + ((at - start) / span) * (width - pad * 2);
  const y = (stars: number) => height - pad - ((stars - low) / range) * (height - pad * 2);
  const line = points.map(point => `${x(point.at.getTime()).toFixed(1)},${y(point.stars).toFixed(1)}`).join(" ");
  const mark = postedAt && postedAt.getTime() > start && postedAt.getTime() < start + span ? x(postedAt.getTime()) : null;
  return (
    <svg className={className} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {mark !== null && <line className="talk-spark-mark" x1={mark} x2={mark} y1={0} y2={height} />}
      <polyline points={line} />
    </svg>
  );
}
