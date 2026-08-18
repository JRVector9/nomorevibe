import Link from "next/link";
import { CATEGORIES } from "@/lib/domain/products/schema";

/**
 * 목록을 좁히는 줄.
 *
 * 링크와 GET 폼으로만 만든다. JS 없이 동작하고, 주소가 그대로 상태라 공유·뒤로가기가
 * 공짜로 따라온다 — 목록 화면에서 그것이 클라이언트 상태보다 낫다.
 */
export type HomeSort = "weekly" | "trending" | "recent" | "all-time";
export type BrowseState = { sort: HomeSort; category?: string; query?: string };

export function parseHomeSort(value: string | undefined): HomeSort {
  if (value === "popular") return "weekly";
  if (value === "trending" || value === "recent" || value === "all-time") return value;
  return "weekly";
}

const SORTS = [
  { key: "weekly", label: "이번 시즌" },
  { key: "trending", label: "급상승" },
  { key: "recent", label: "최신" },
  { key: "all-time", label: "역대 인기" },
] as const;

/** 지금 상태에서 한 가지만 바꾼 주소 — 필터를 겹쳐 걸 수 있어야 한다 */
function hrefWith(state: BrowseState, patch: Partial<BrowseState>): string {
  const next = { ...state, ...patch };
  const params = new URLSearchParams();
  if (next.sort !== "weekly") params.set("sort", next.sort);
  if (next.category) params.set("category", next.category);
  if (next.query) params.set("q", next.query);
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

const chip = (active: boolean) =>
  `rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold ${
    active ? "border-accent text-accent" : "border-line text-fg-2 hover:text-fg"
  }`;

export function BrowseFilters({
  state,
  counts,
  total,
}: {
  state: BrowseState;
  /** 카테고리별 개수. 0인 칸은 눌러봐야 빈 화면이므로 감춘다 */
  counts: Record<string, number>;
  total: number;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {SORTS.map(({ key, label }) => (
          <Link key={key} href={hrefWith(state, { sort: key })} className={chip(state.sort === key)}>
            {label}
          </Link>
        ))}
        {(state.sort === "weekly" || state.sort === "trending" || state.sort === "all-time") && (
          <span className="text-[11.5px] text-fg-3">검증된 제품만</span>
        )}

        {/* 검색은 폼 하나로 끝난다. 정렬·카테고리는 숨은 필드로 함께 실어 보낸다 */}
        <form action="/" method="get" className="ml-auto flex items-center gap-1.5">
          {state.sort !== "weekly" && <input type="hidden" name="sort" value={state.sort} />}
          {state.category && <input type="hidden" name="category" value={state.category} />}
          <input
            type="search"
            name="q"
            defaultValue={state.query ?? ""}
            placeholder="제품 검색"
            className="w-[180px] rounded-lg border border-line bg-bg-soft px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent"
          />
          <button type="submit" className={chip(false)}>
            찾기
          </button>
        </form>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link href={hrefWith(state, { category: undefined })} className={chip(!state.category)}>
          전체 <span className="ml-1 font-mono text-[11px] text-fg-3">{total}</span>
        </Link>
        {CATEGORIES.filter((category) => (counts[category] ?? 0) > 0).map((category) => (
          <Link
            key={category}
            href={hrefWith(state, { category })}
            className={chip(state.category === category)}
          >
            {category} <span className="ml-1 font-mono text-[11px] text-fg-3">{counts[category]}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
