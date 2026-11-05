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
      <div className="inbox-card-head">
        <div className="inbox-card-heading">
          <div className="inbox-card-title-row">
            <h2 id={headingId} className="inbox-card-title">{section.title}</h2>
            {data ? (
              <>
                <span className="inbox-priority" data-tone={section.tone}>
                  {section.tone === "critical" ? "긴급" : "확인 필요"}
                </span>
                <span className="inbox-count">{count(data.count)}건</span>
              </>
            ) : (
              <span className="inbox-failed">불러오지 못함</span>
            )}
          </div>
          <p className="inbox-card-hint">{section.hint}</p>
        </div>
        <div className="inbox-card-side">
          {oldest && <span className="inbox-oldest" title={formatDetailTime(oldest)}>가장 오래된 것 {formatAgo(oldest, now)}</span>}
          {data?.note && <span className="inbox-note">{data.note}</span>}
          <Link href={section.href} className="inbox-action">
            {section.action}{data && data.count > data.items.length ? ` — ${count(data.count)}건 모두 보기` : ""} →
          </Link>
        </div>
      </div>

      {data && data.items.length > 0 && (
        <ul className="inbox-list">
          {data.items.map((item) => (
            <li key={item.id} className="inbox-item">
              <span className="inbox-item-name">{item.name}</span>
              <span className="inbox-item-why">
                {section.key === "human" ? REASON_LABELS[item.why] ?? (item.why || "사유 없음") : item.why}
              </span>
              <span className="inbox-item-time" title={formatDetailTime(item.since)}>{formatAgo(item.since, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
