import Link from "next/link";
import type { AttentionAck } from "@/lib/operations/attention";
import { formatAgo, formatListTime } from "@/lib/format/time";
import { StatusDot } from "../../components/StatusDot";
import { AttentionDetail } from "./AttentionDetail";
import { AttentionAckButton } from "./AttentionAckButton";
import { Flash } from "./Flash";

/** 조치 한 칸 — 무엇이·왜 막혔고·어디로 가면 되는지. 막고 있는 순서대로 쌓는다. */
export type ActionItem = {
  key: string;
  tone: "critical" | "hold" | "clear";
  count: number | string;
  /** 숫자 옆 단위(건·%·회…). 숫자가 아닌 상태 글자("끊김")는 "상태" — 크기가 다른 값이 한 칸에 섞여 있었다(ADM-08) */
  unit: string;
  title: string;
  detail: React.ReactNode;
  action?: { label: string; href: string };
};

/** 나눈 뒤의 한 칸 — 기준 시각(약 24시간 전) 대비 변화, 새로 생겼는지, 숨긴 사람 */
export type SplitItem = ActionItem & {
  /** 쌓인 일의 변화 — 기준이 없거나 숫자가 아니면 null */
  trend: { delta: number; hours: number } | null;
  /** 기준 시각에 없던 것 */
  fresh: boolean;
  ack?: AttentionAck;
};

const TONE_ORDER: Record<ActionItem["tone"], number> = { critical: 0, hold: 1, clear: 2 };

/**
 * 급한 것부터 — critical → hold → clear. 같은 급 안에서는 넣은 차례(attention.tsx 의 "막는 순서")를 지킨다.
 * 전에는 넣은 차례 그대로라 hold 인 "사람이 가려야 할 후보"가 1번, critical 인 "응답하지 않는 공개 제품"이 4번이었다(2026-10-08 감사 ADM-02).
 */
export function sortActions<T extends ActionItem>(items: T[]): T[] {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => TONE_ORDER[a.item.tone] - TONE_ORDER[b.item.tone] || a.index - b.index)
    .map(({ item }) => item);
}

const n = (value: number) => value.toLocaleString("ko-KR");

/** 쌓인 일 칸의 변화 글자 — "↑ 24h +1,203", "↓ 24h −50", "→ 24h 그대로". 기록이 하루가 안 되면 그 시간으로 적는다 */
export function trendLabel(trend: SplitItem["trend"]): string | null {
  if (!trend) return null;
  const window = trend.hours >= 20 ? "24h" : `${trend.hours}시간`;
  if (trend.delta === 0) return `→ ${window} 그대로`;
  return trend.delta > 0 ? `↑ ${window} +${n(trend.delta)}` : `↓ ${window} −${n(-trend.delta)}`;
}

function Row({ item, side }: { item: SplitItem; side?: React.ReactNode }) {
  const tone = item.tone === "critical" ? "bad" : item.tone === "hold" ? "warn" : "ok";
  return (
    <li data-tone={tone}>
      <i aria-hidden />
      <div className="min-w-0">
        <div className="t" title={item.title}>{item.fresh && <span className="dash-todo-new">새로 생김</span>}{item.title}</div>
        <AttentionDetail>{item.detail}</AttentionDetail>
      </div>
      {/* 숫자와 가는 곳을 둘 다 — 링크만 두니 열한 줄 중 열 줄이 "얼마나"를 말하지 않았다(2026-10-08) */}
      <div className="dash-todo-side flex shrink-0 flex-col items-end gap-0.5">
        <span className="n"><Flash value={item.count}>{typeof item.count === "number" ? n(item.count) : item.count}</Flash><small>{item.unit}</small></span>
        {item.action && <Link href={item.action.href}>{item.action.label}</Link>}
        {side}
      </div>
    </li>
  );
}

/**
 * 조치할 일 — 운영센터 첫 화면 맨 위. "지금 조치"와 "쌓인 일" 두 칸(2026-10-08 UX 감사 ADM-08).
 *
 * 전에는 만성 백로그(근거 갱신 39,749·저장소 확인 범위 4%)가 진짜 장애와 같은 줄에 같은 모양으로 섞였다.
 * 지금 조치는 critical·새로 생긴 것만, 쌓인 일은 24시간 변화와 "확인함 · 7일 숨김"을 단다(숨김은 작업 로그에 남는다).
 * 세로 한 줄로 두고 왼쪽 띠 색과 오른쪽 숫자(단위 포함)로 무게를 보인다. 설명은 두 줄까지 보이고 넘치면 펼친다.
 */
export function AttentionList({ urgent, backlog, hidden, now }: { urgent: SplitItem[]; backlog: SplitItem[]; hidden: SplitItem[]; now: string }) {
  return (
    <>
      <section className="dash-card dash-6" aria-labelledby="todo-now">
        <div className="dash-card-h"><h2 id="todo-now">지금 조치</h2><small>급한 것·새로 생긴 것 · 급한 것부터</small></div>
        {urgent.length > 0 ? (
          <ul className="dash-todo">{urgent.map((item) => <Row key={item.key} item={item} />)}</ul>
        ) : (
          <p className="dash-todo-empty"><StatusDot state="ok" label="지금 손댈 것이 없습니다" /> 실패한 작업·끊긴 워커·새로 생긴 일이 없습니다.</p>
        )}
      </section>
      <section className="dash-card dash-6" aria-labelledby="todo-backlog">
        <div className="dash-card-h"><h2 id="todo-backlog">쌓인 일</h2><small>늘 떠 있는 백로그 · 24시간 변화</small></div>
        {backlog.length > 0 ? (
          <ul className="dash-todo">
            {backlog.map((item) => (
              <Row key={item.key} item={item} side={<>
                <span className="dash-todo-trend">{trendLabel(item.trend) ?? "변화 기록 없음"}</span>
                <AttentionAckButton itemKey={item.key} title={item.title} count={item.count} hide />
              </>} />
            ))}
          </ul>
        ) : <p className="dash-todo-empty">쌓인 일이 없습니다{hidden.length > 0 ? " — 숨긴 것은 아래에 있습니다" : ""}.</p>}
        {hidden.length > 0 && (
          <details className="dash-todo-hidden">
            <summary>확인함으로 숨긴 것 {n(hidden.length)}건</summary>
            <ul className="dash-todo">
              {hidden.map((item) => (
                <Row key={item.key} item={item} side={<>
                  {item.ack && <span className="dash-todo-trend" title={formatListTime(item.ack.at, now)}>
                    {item.ack.actor} 확인 {formatAgo(item.ack.at, now)} · {formatListTime(item.ack.until, now)}까지</span>}
                  <AttentionAckButton itemKey={item.key} title={item.title} count={item.count} hide={false} />
                </>} />
              ))}
            </ul>
          </details>
        )}
      </section>
    </>
  );
}
