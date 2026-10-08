import Link from "next/link";
import { AttentionDetail } from "./AttentionDetail";

/** 조치 한 칸 — 무엇이·왜 막혔고·어디로 가면 되는지. 막고 있는 순서대로 쌓는다. */
export type ActionItem = {
  key: string;
  tone: "critical" | "hold" | "clear";
  count: number | string;
  title: string;
  detail: React.ReactNode;
  action?: { label: string; href: string };
};

const TONE_ORDER: Record<ActionItem["tone"], number> = { critical: 0, hold: 1, clear: 2 };

/**
 * 급한 것부터 — critical → hold → clear. 같은 급 안에서는 넣은 차례(page.tsx 의 "막는 순서")를 지킨다.
 * 전에는 넣은 차례 그대로라 hold 인 "사람이 가려야 할 후보"가 1번, critical 인 "응답하지 않는 공개 제품"이 4번이었다(2026-10-08 감사 ADM-02).
 */
export function sortActions(items: ActionItem[]): ActionItem[] {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => TONE_ORDER[a.item.tone] - TONE_ORDER[b.item.tone] || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * 조치할 일 — 운영센터 첫 화면 맨 위, 전체 폭.
 *
 * 세로 한 줄로 두고 왼쪽 띠 색과 오른쪽 숫자로 무게를 보인다. 설명은 두 줄까지 보이고 넘치면 펼친다.
 * 급한 것(critical)이 없으면 "지금 급한 것 없음 · 쌓인 일 N건" 한 줄로 접어 KPI·파이프라인을 밀어내지 않는다.
 */
export function AttentionList({ items }: { items: ActionItem[] }) {
  const tone = (item: ActionItem) => item.tone === "critical" ? "bad" : item.tone === "hold" ? "warn" : "ok";
  const sorted = sortActions(items);
  const urgent = sorted.some((item) => item.tone === "critical");
  const pending = sorted.filter((item) => item.key !== "clear");
  const list = (
    <ul className="dash-todo">
      {sorted.map((item) => (
        <li key={item.key} data-tone={tone(item)}>
          <i aria-hidden />
          <div className="min-w-0">
            <div className="t" title={item.title}>{item.title}</div>
            <AttentionDetail>{item.detail}</AttentionDetail>
          </div>
          {/* 숫자와 가는 곳을 둘 다 — 링크만 두니 열한 줄 중 열 줄이 "얼마나"를 말하지 않았다(2026-10-08) */}
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <span className="n">{typeof item.count === "number" ? item.count.toLocaleString("ko-KR") : item.count}</span>
            {item.action && <Link href={item.action.href}>{item.action.label}</Link>}
          </div>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="dash-card dash-12" aria-label="조치할 일">
      {urgent || pending.length === 0 ? (
        <>
          <div className="dash-card-h"><h2>조치할 일</h2><small>급한 것부터 · 같은 급은 막는 순서</small></div>
          {list}
        </>
      ) : (
        <details className="dash-todo-fold">
          <summary><h2>조치할 일</h2><span>지금 급한 것 없음 · 쌓인 일 {pending.length.toLocaleString("ko-KR")}건</span></summary>
          {list}
        </details>
      )}
    </section>
  );
}
