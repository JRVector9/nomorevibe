/**
 * 24칸 작은 선 그래프 — 오래된 것부터 왼쪽, 끝점이 이번 시간.
 *
 * 축·눈금 없이 모양만 보는 그래프라, 값이 다 0이면 바닥에 평평한 선으로 그린다.
 * 색은 테마 토큰(--color-*)으로만 받는다 — 밝은·어두운 테마 어디서든 읽혀야 한다.
 */
export function Sparkline({ values, tone = "accent", label }: {
  values: number[]; tone?: "accent" | "up" | "warn" | "down"; label?: string;
}) {
  const width = 120, height = 34, pad = 2;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const points = values.map((value, index) => {
    const x = pad + index * step;
    const y = height - pad - (value / max) * (height - pad * 2);
    return [x, y] as const;
  });
  const path = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const color = `var(--color-${tone})`;
  return (
    <svg className="dash-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role={label ? "img" : undefined}
      aria-label={label} aria-hidden={label ? undefined : true}>
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={path} vectorEffect="non-scaling-stroke" />
      {last && <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />}
    </svg>
  );
}
