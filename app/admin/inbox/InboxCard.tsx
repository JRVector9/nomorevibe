import Link from "next/link";
import { formatAgo, formatDetailTime } from "@/lib/format/time";
import { REASON_LABELS } from "../reasons";
import type { InboxSection } from "./inbox-model";

const count = (value: number) => value.toLocaleString("ko-KR");

/**
 * 칸 하나 — 수, 가장 오래 기다린 것, 오래된 것부터 다섯 줄, 처리하는 화면으로 가는 링크.
 * 못 읽은 칸은 "불러오지 못함"과 링크만 그린다. now 는 서버가 읽은 시각(ISO)이다.
 */
export function InboxCard({ section, now }: { section: InboxSection; now: string }) {
  const { data } = section;
  const oldest = data?.items[0]?.since ?? null;
  const headingId = `inbox-${section.key}`;
  return (
    <section className="inbox-card" data-tone={section.state === "failed" ? "failed" : section.tone} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-[16px] font-bold">{section.title}</h2>
        {data ? (
          <>
            <span className="inbox-count font-mono text-[18px] font-extrabold">{count(data.count)}건</span>
            {oldest && <span className="text-[13px] text-fg-2" title={formatDetailTime(oldest)}>가장 오래된 것 {formatAgo(oldest, now)}</span>}
            {data.note && <span className="text-[13px] text-fg-3">{data.note}</span>}
          </>
        ) : (
          <span className="inbox-failed text-[13px] font-semibold">불러오지 못함</span>
        )}
      </div>
      <p className="mt-1 text-[13px] text-fg-3">{section.hint}</p>

      {data && data.items.length > 0 && (
        <ul className="mt-2 divide-y divide-line border-y border-line">
          {data.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-[13px]">
              <span className="min-w-0 break-all font-semibold text-fg">{item.name}</span>
              <span className="min-w-0 flex-1 basis-[220px] text-fg-2">
                {section.key === "human" ? REASON_LABELS[item.why] ?? (item.why || "사유 없음") : item.why}
              </span>
              <span className="ml-auto shrink-0 font-mono text-fg-3" title={formatDetailTime(item.since)}>{formatAgo(item.since, now)}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[13px]">
        <Link href={section.href} className="font-semibold text-accent">
          {section.action}{data && data.count > data.items.length ? ` — ${count(data.count)}건 모두 보기` : ""} →
        </Link>
      </p>
    </section>
  );
}
