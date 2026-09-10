import Link from "next/link";

/**
 * 지금 사람이 손대야 하는 것.
 *
 * 관측값을 늘어놓으면 "무엇을 해야 하는지"는 여전히 읽는 사람이 조립해야 한다. 막고 있는
 * 순서대로 놓고, 각 줄에 무엇이·왜 막혔고·어디로 가면 되는지를 함께 적는다. 위에서부터
 * 처리하면 아래가 저절로 풀리도록 순서를 정한다.
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
    <section className="mt-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[17px] font-bold">지금 조치가 필요한 것</h2>
        <p className="text-[13px] text-fg-3">막고 있는 순서대로입니다. 위에서부터 처리하면 아래가 저절로 풀립니다.</p>
      </div>

      <ul className="mt-3 overflow-hidden rounded-[12px] border border-line bg-bg-card">
        {items.map((item) => (
          <li key={item.key} className="flex items-stretch gap-4 border-t border-line first:border-t-0">
            <span className={`w-[4px] shrink-0 ${TONE[item.tone].stripe}`} aria-hidden />
            <span className={`w-[42px] shrink-0 self-center text-right font-mono text-[19px] font-bold tabular-nums ${TONE[item.tone].count}`}>
              {item.count}
            </span>
            <div className="min-w-0 flex-1 py-3.5">
              <p className="text-[14px] font-bold">{item.title}</p>
              <p className="mt-1 text-[13px] leading-[1.7] text-fg-2">{item.detail}</p>
            </div>
            {item.action && (
              <div className="flex shrink-0 items-center pr-4">
                <Link href={item.action.href}
                  className="rounded-lg border border-line px-3 py-2 text-[13px] font-semibold text-fg-2 hover:bg-bg-hover">
                  {item.action.label}
                </Link>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
