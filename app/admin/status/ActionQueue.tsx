import Link from "next/link";

/**
 * 지금 사람이 손대야 하는 것.
 *
 * 관측값을 늘어놓으면 "무엇을 해야 하는지"는 여전히 읽는 사람이 조립해야 한다. 막고 있는
 * 순서대로 놓고, 각 칸에 무엇이·왜 막혔고·어디로 가면 되는지를 함께 적는다. 위(왼쪽)부터
 * 처리하면 아래가 저절로 풀리도록 순서를 정한다. 한 칸에 두 줄 — 한 화면 운영센터의 한 줄을 넘지 않는다.
 */
export type ActionItem = {
  key: string;
  tone: "critical" | "hold" | "clear";
  count: number | string;
  title: string;
  detail: React.ReactNode;
  action?: { label: string; href: string };
};

const TONE = {
  critical: { stripe: "bg-down", count: "text-down" },
  hold: { stripe: "bg-warn", count: "text-warn" },
  clear: { stripe: "bg-up", count: "text-up" },
} as const;

export function ActionQueue({ items }: { items: ActionItem[] }) {
  return (
    <section aria-label="지금 조치가 필요한 것" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <div key={item.key} className="flex min-w-0 items-stretch overflow-hidden rounded-[10px] border border-line bg-bg-card">
          <span className={`w-[4px] shrink-0 ${TONE[item.tone].stripe}`} aria-hidden />
          <span className={`w-[48px] shrink-0 self-center text-right font-mono text-[17px] font-bold tabular-nums ${TONE[item.tone].count}`}>
            {item.count}
          </span>
          <div className="min-w-0 flex-1 px-3 py-2">
            <p className="truncate text-[13px] font-bold">{item.title}</p>
            <p className="line-clamp-1 text-[13px] text-fg-3">{item.detail}</p>
          </div>
          {item.action && (
            <Link href={item.action.href} className="flex shrink-0 items-center border-l border-line px-3 text-[13px] font-semibold text-accent hover:bg-bg-hover">
              {item.action.label}
            </Link>
          )}
        </div>
      ))}
    </section>
  );
}
