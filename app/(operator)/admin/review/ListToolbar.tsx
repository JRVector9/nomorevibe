import Form from "next/form";
import Link from "next/link";
import type { ReviewSort } from "@/lib/crawl/admin-review";

/**
 * 목록 위 필터 — 검색과 마지막 업데이트.
 *
 * 구간·세부 거르기는 "무엇을 볼지"를 고르고, 이것은 그 목록을 더 좁힌다. 둘 다 URL 에 남아 쪽을 넘겨도
 * 유지된다. 업데이트 필터는 화면에서만 빼고 후보는 그대로 둔다 — 자동으로 거부하지 않기로 했다(2026-09-19).
 */
export const UPDATED_WINDOWS = [["", "전체"], ["1m", "1개월 이내"], ["3m", "3개월 이내"], ["6m", "6개월 이내"]] as const;
export type UpdatedWindow = typeof UPDATED_WINDOWS[number][0];
export const UPDATED_DAYS: Record<Exclude<UpdatedWindow, "">, number> = { "1m": 30, "3m": 90, "6m": 180 };
const UPDATED_SPAN: Record<Exclude<UpdatedWindow, "">, string> = { "1m": "1개월", "3m": "3개월", "6m": "6개월" };
/** 표 머리의 정렬과 같은 값 — 머리를 눌러도, 여기서 골라도 같은 URL 이 된다 */
const SORT_LABELS: [ReviewSort, string][] = [["", "들어온 차례"], ["wait", "오래 기다린 것부터"], ["wait_short", "막 들어온 것부터"],
  ["stars", "별이 많은 것부터"], ["push", "최근에 손댄 것부터"], ["push_old", "오래 멈춘 것부터"]];

/** 표 위 한 줄(거르기 ▾ 옆) — 검색·기간·정렬. 좁은 화면에서는 줄을 바꿔 선다 */
export function ListToolbar({ keep, q, updated, sort, total, hiddenByAge, clearHref }: {
  /** 지금 고른 구간·거르기 — 필터를 적용해도 그대로 둔다 */
  keep: Record<string, string | undefined>;
  q: string; updated: UpdatedWindow; sort: ReviewSort; total: number; hiddenByAge: number; clearHref: string;
}) {
  return (
    <Form action="/admin/review" scroll={false} className="rq-search">
      {Object.entries(keep).map(([name, value]) => value ? <input key={name} type="hidden" name={name} value={value} /> : null)}
      <input name="q" type="search" defaultValue={q} maxLength={100} placeholder="이름·레포·주소" aria-label="검색"
        className="min-w-[160px] flex-1 rounded-lg border border-line bg-bg-soft px-2.5 py-1.5 text-[13px]" />
      <select name="updated" defaultValue={updated} aria-label="마지막 업데이트" className="rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-[13px]">
        {UPDATED_WINDOWS.map(([value, label]) => <option key={value} value={value}>{value ? `마지막 업데이트 ${label}` : "마지막 업데이트 전체"}</option>)}
      </select>
      <select name="sort" defaultValue={sort} aria-label="정렬" className="rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-[13px]">
        {SORT_LABELS.map(([value, label]) => <option key={value || "default"} value={value}>{label}</option>)}
      </select>
      <button type="submit" className="rounded-lg border border-accent bg-accent px-3 py-1.5 text-[13px] font-semibold text-white">적용</button>
      {(q || updated || sort) && <Link href={clearHref} scroll={false} className="text-[13px] text-fg-2 hover:text-fg">필터 지우기</Link>}
      <span className="ml-auto text-[13px] text-fg-3">
        {total.toLocaleString("ko-KR")}건
        {hiddenByAge > 0 && updated && ` · 마지막 업데이트가 ${UPDATED_SPAN[updated]}보다 오래된 ${hiddenByAge.toLocaleString("ko-KR")}건은 뺐습니다`}
      </span>
    </Form>
  );
}
