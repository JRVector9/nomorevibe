import Link from "next/link";
import Form from "next/form";
import type { AdminReviewEntry, ReviewAiDecision } from "@/lib/crawl/admin-review";
import { CAUSE_GUIDE, causeLabel } from "../review/causes";
import { QUEUE_AI_FILTERS, QUEUE_PAGE_SIZE, QUEUE_PUSH_FILTERS, QUEUE_STAR_FILTERS, queueEntryCause, queueFilterHref, type QueueFilters } from './queue-filters';

const AI: Record<string, { label: string; className: string }> = {
  reject: { label: "AI 거부", className: "bg-down/10 text-down" },
  approve: { label: "AI 승인", className: "bg-up/10 text-up" },
  needs_review: { label: "AI 보류", className: "bg-bg-soft text-fg-2" },
};
const control = 'mt-1 block w-full min-w-0 rounded-md border border-line bg-bg-card px-2 py-1.5 text-[13px] font-normal text-fg focus:outline-2 focus:outline-accent';

/**
 * 운영센터 가운데의 심사 대기 — 처리는 심사 큐에서 한다.
 *
 * 운영센터만 열어도 무엇이 기다리는지, AI가 무엇이라고 했는지가 보여야 한다. 줄을 누르면
 * 심사 큐에서 그 후보가 골라진 채로 열린다.
 */
export function QueuePreview({ entries, total, counts, filters, totalWaiting, filterScanTruncated = false }: {
  entries: AdminReviewEntry[]; total: number; counts: Record<ReviewAiDecision, number>;
  filters: QueueFilters; totalWaiting: number; filterScanTruncated?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE));
  const filtered = Boolean(filters.q || filters.cause || filters.ai || filters.minStars || filters.updated);
  return (
    <section aria-label="심사 대기" className="overflow-hidden rounded-[12px] border border-line bg-bg-card">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2 text-[13px]">
        <b className="mr-1 font-bold">심사 대기 {totalWaiting.toLocaleString("ko-KR")}</b>
        {QUEUE_AI_FILTERS.map(([key, label]) => (
          <Link key={key} href={queueFilterHref(filters, { ai: filters.ai === key ? '' : key })} scroll={false}
            aria-current={filters.ai === key ? 'page' : undefined}
            className={`rounded-full border px-2 py-0.5 ${filters.ai === key ? 'border-accent bg-accent-soft text-accent' : 'border-line text-fg-2 hover:bg-bg-hover'}`}>
            {label} <span className="font-mono">{counts[key]}</span>
          </Link>
        ))}
        <Link href="/admin/review?state=needs_review" className="ml-auto font-semibold text-accent">심사 큐에서 처리 →</Link>
      </div>
      <Form action="/admin/status" scroll={false} key={queueFilterHref(filters, { page: filters.page })}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[13px]">
        <span className="mr-auto text-fg-2">{filtered ? '필터 결과' : '전체 대기'} <b className="text-fg">{total.toLocaleString('ko-KR')}건</b> · 갈래는 보류 이유입니다.</span>
        <button type="submit" className="primary">필터 적용</button>
        {filtered && <Link href="/admin/status" scroll={false} className="px-1 py-1.5 text-fg-2 underline">초기화</Link>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] table-fixed text-[13px] tabular-nums">
          <colgroup><col /><col className="w-[210px]" /><col className="w-[120px]" /><col className="w-[110px]" /><col className="w-[130px]" /></colgroup>
          <thead className="bg-bg-soft text-left text-fg-3">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold"><label>후보<input type="search" name="q" defaultValue={filters.q} maxLength={100} placeholder="이름·저장소·주소" className={control}/></label></th>
              <th scope="col" className="px-2 py-2 font-semibold"><label>갈래<select name="cause" defaultValue={filters.cause} className={control}>
                <option value="">전체 갈래</option>{Object.entries(CAUSE_GUIDE).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
              </select></label></th>
              <th scope="col" className="px-2 py-2 font-semibold"><label>AI 1차<select name="ai" defaultValue={filters.ai} className={control}>
                <option value="">전체 판단</option>{QUEUE_AI_FILTERS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select></label></th>
              <th scope="col" className="px-2 py-2 font-semibold"><label>★ 별 수<select name="minStars" defaultValue={filters.minStars} className={control}>
                <option value="">전체</option>{QUEUE_STAR_FILTERS.map(value => <option key={value} value={value}>{Number(value).toLocaleString('ko-KR')} 이상</option>)}
              </select></label></th>
              <th scope="col" className="px-3 py-2 font-semibold"><label>최근 푸시<select name="updated" defaultValue={filters.updated} className={control}>
                <option value="">전체 기간</option>{QUEUE_PUSH_FILTERS.map(value => <option key={value} value={value}>{value}일 이내</option>)}
              </select></label></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const signals = (entry.verdict?.signals ?? entry.candidate.signals ?? {}) as Record<string, unknown>;
              const chip = entry.review?.decision ? AI[entry.review.decision] : null;
              return (
                <tr key={entry.candidate.id} className="border-t border-line hover:bg-bg-hover">
                  <td className="px-3 py-1.5">
                    <Link href={`/admin/review?state=needs_review&focus=${entry.candidate.id}`} className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-semibold">{entry.name}</span>
                      <span className="truncate font-mono text-fg-3">{entry.candidate.repo}</span>
                    </Link>
                  </td>
                  <td className="px-2 py-1.5"><span className="block truncate rounded bg-warn/10 px-1.5 py-0.5 font-semibold text-warn" title={causeLabel(queueEntryCause(entry))}>{causeLabel(queueEntryCause(entry))}</span></td>
                  <td className="whitespace-nowrap px-2 py-1.5">{chip ? <span className={`rounded px-1.5 py-0.5 font-semibold ${chip.className}`}>{chip.label}</span> : <span className="text-fg-3">—</span>}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right">{typeof signals.stars === "number" ? signals.stars.toLocaleString('ko-KR') : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">{typeof signals.pushAgeDays === "number" ? `${signals.pushAgeDays}일` : "—"}</td>
                </tr>
              );
            })}
            {entries.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-fg-3">{filtered ? '조건에 맞는 후보가 없습니다. 필터를 바꾸거나 초기화해주세요.' : '이 페이지에 심사 대기 후보가 없습니다.'}</td></tr>}
          </tbody>
        </table>
      </div>
      </Form>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-3 py-2 text-[13px] text-fg-2">
        <span className="mr-auto">{filters.page}/{pages}쪽 · {entries.length}건 표시{filters.updated && ' · 푸시 시각 미상 포함'}</span>
        {filters.page > 1 && <Link href={queueFilterHref(filters, { page: filters.page - 1 })} scroll={false} className="font-semibold text-accent">이전</Link>}
        {filters.page < pages && <Link href={queueFilterHref(filters, { page: filters.page + 1 })} scroll={false} className="font-semibold text-accent">다음</Link>}
      </div>
      {filterScanTruncated && <p className="px-3 pb-2 text-[13px] text-warn">갈래·AI 집계와 해당 필터는 스캔 상한 안의 후보에 적용됩니다. 전체 대기는 필터를 초기화해 확인해주세요.</p>}
    </section>
  );
}
