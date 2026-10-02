import Link from "next/link";

/** 조치 한 칸 — 무엇이·왜 막혔고·어디로 가면 되는지. 막고 있는 순서대로 쌓는다. */
export type ActionItem = {
  key: string;
  tone: "critical" | "hold" | "clear";
  count: number | string;
  title: string;
  detail: React.ReactNode;
  action?: { label: string; href: string };
};

/**
 * 조치할 일 — 큰 것부터 한 줄씩.
 *
 * 카드 격자(ActionQueue)는 세 칸에 흩어져 어느 것이 먼저인지 읽히지 않았다. 세로 한 줄로 두고
 * 왼쪽 띠 색과 오른쪽 숫자로 무게를 보인다.
 */
export function AttentionList({ items }: { items: ActionItem[] }) {
  const tone = (item: ActionItem) => item.tone === "critical" ? "bad" : item.tone === "hold" ? "warn" : "ok";
  return (
    <section className="dash-card dash-4" aria-label="조치할 일">
      <div className="dash-card-h"><h2>조치할 일</h2><small>큰 것부터</small></div>
      <ul className="dash-todo">
        {items.map((item) => (
          <li key={item.key} data-tone={tone(item)}>
            <i aria-hidden />
            <div className="min-w-0">
              <div className="t">{item.title}</div>
              <div className="d">{item.detail}</div>
            </div>
            {item.action ? <Link href={item.action.href}>{item.action.label}</Link> : <span className="n">{item.count}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
