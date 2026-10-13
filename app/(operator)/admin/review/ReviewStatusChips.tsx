import type { ModelHealth } from "@/lib/operations/dashboard";

const n = (value: number) => value.toLocaleString("ko-KR");
type Tone = "ok" | "warn" | "bad" | "acc" | undefined;

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className="dash-pill" data-tone={tone}><span className="dash-dot" data-tone={tone === "acc" ? undefined : tone} aria-hidden />{children}</span>;
}

/**
 * 심사 큐 머리말 칩 — 심사하는 동안 모델이 살아 있는지, 오늘 얼마나 처리했는지.
 *
 * 1·2차 모델의 지난 1시간(운영센터 모델 카드와 같은 modelHealth), 사람이 24시간에 내린 결정,
 * 24시간 발행 순증감, 내려달라는 요청. 2차 일치가 70% 아래면 갈림이 사람 큐로 쌓인다는 뜻이라 주황이다.
 *
 * 오늘 목표(2026-10-08 UX 감사 ADM-07) — 최근 24시간에 직접 판단으로 들어와 아직 남은 수(inflow)다. 그만큼은 처리해야
 * 사람 큐가 늘지 않는다. 사람이 하나도 처리하지 않았는데 들어온 것이 있으면 '24h 사람 처리'와 목표 칩이 주황이 된다
 * (전에는 0건도 회색이라 경고로 보이지 않았다).
 */
export function ReviewStatusChips({ models, human, publication, takedowns, inflow = null }: {
  models: ModelHealth[] | null; human: { approve: number; reject: number } | null;
  publication: { net: number }; takedowns: number;
  /** 최근 24시간에 직접 판단으로 들어와 남은 수 — 오늘 목표. 못 읽으면 null */
  inflow?: number | null;
}) {
  const first = models?.find((row) => row.key === "first");
  const second = models?.find((row) => row.key === "second");
  const failTone = (row: ModelHealth): Tone => {
    if (row.calls1h === 0) return undefined;
    const rate = row.failed1h / row.calls1h;
    return rate >= 0.2 ? "bad" : rate >= 0.1 ? "warn" : "ok";
  };
  const done = human ? human.approve + human.reject : null;
  // 사람이 손을 놓았는데 일이 들어오고 있다
  const idle = done === 0 && (inflow ?? 0) > 0;
  const secondTone: Tone = second && second.calls1h > 0 && second.agreement1h !== null && second.agreement1h < 0.7 ? "warn" : second ? failTone(second) : undefined;
  return (
    <div className="dash-chips" aria-label="심사 상태 요약">
      {first && <Chip tone={failTone(first)}>1차 {first.model ?? "설정 없음"} · 1h <span className="font-mono">{n(first.calls1h)}</span>건 · 실패 <span className="font-mono">{n(first.failed1h)}</span></Chip>}
      {second && <Chip tone={secondTone}>2차 {second.model ?? "설정 없음"} · 1h <span className="font-mono">{n(second.calls1h)}</span>건
        {second.agreement1h !== null && <> · 1차와 일치 <span className="font-mono">{Math.round(second.agreement1h * 100)}%</span></>}</Chip>}
      {human && <Chip tone={idle ? "warn" : undefined}>24h 사람 처리 <span className="font-mono">{n(human.approve + human.reject)}</span>건 · 승인 {n(human.approve)} · 거부 {n(human.reject)}</Chip>}
      {human && inflow !== null && <span title="오늘 목표 = 최근 24시간에 직접 판단으로 들어와 아직 남은 수. 그만큼 처리해야 사람 큐가 늘지 않는다">
        <Chip tone={idle ? "warn" : human.approve + human.reject >= inflow && inflow > 0 ? "ok" : undefined}>오늘 목표 <span className="font-mono">{n(inflow)}</span>건 / 처리 <span className="font-mono">{n(human.approve + human.reject)}</span>건</Chip>
      </span>}
      <Chip tone={publication.net > 0 ? "ok" : publication.net < 0 ? "warn" : undefined}>24h 발행 <span className="font-mono">{publication.net >= 0 ? "+" : ""}{n(publication.net)}</span></Chip>
      <Chip tone={takedowns > 0 ? "bad" : undefined}>내려달라는 요청 <span className="font-mono">{n(takedowns)}</span></Chip>
    </div>
  );
}
