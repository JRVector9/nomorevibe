import Form from "next/form";
import Link from "next/link";

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

export function ListToolbar({ keep, q, updated, total, hiddenByAge, clearHref }: {
  /** 지금 고른 구간·거르기 — 필터를 적용해도 그대로 둔다 */
  keep: Record<string, string | undefined>;
  q: string; updated: UpdatedWindow; total: number; hiddenByAge: number; clearHref: string;
}) {
  return (
    <Form action="/admin/review" scroll={false} className="flex flex-wrap items-center gap-2 rounded-[12px] border border-line bg-bg-card px-3 py-2">
      {Object.entries(keep).map(([name, value]) => value ? <input key={name} type="hidden" name={name} value={value} /> : null)}
      <label className="flex min-w-[220px] flex-1 items-center gap-2 text-[13px]">
        <span className="shrink-0 font-semibold text-fg-2">검색</span>
        <input name="q" type="search" defaultValue={q} maxLength={100} placeholder="이름·레포·주소"
          className="w-full rounded-lg border border-line bg-bg-soft px-2.5 py-1.5 text-[13px]" />
      </label>
      <label className="flex items-center gap-2 text-[13px]">
        <span className="shrink-0 font-semibold text-fg-2">마지막 업데이트</span>
        <select name="updated" defaultValue={updated} className="rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-[13px]">
          {UPDATED_WINDOWS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <button type="submit" className="rounded-lg border border-accent bg-accent px-3 py-1.5 text-[13px] font-semibold text-white">적용</button>
      {(q || updated) && <Link href={clearHref} scroll={false} className="text-[13px] text-fg-2 hover:text-fg">필터 지우기</Link>}
      <span className="ml-auto text-[13px] text-fg-3">
        {total.toLocaleString("ko-KR")}건
        {hiddenByAge > 0 && updated && ` · 마지막 업데이트가 ${UPDATED_SPAN[updated]}보다 오래된 ${hiddenByAge.toLocaleString("ko-KR")}건은 뺐습니다`}
      </span>
    </Form>
  );
}
