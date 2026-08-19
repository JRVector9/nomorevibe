import Link from "next/link";

/** 어드민 화면 사이 이동. 세 화면이 각자 링크를 들고 있으면 하나씩 어긋난다 */
const PAGES = [
  { href: "/admin", label: "크롤 설정" },
  { href: "/admin/review", label: "심사 큐" },
  { href: "/admin/status", label: "수집 현황" },
  { href: "/admin/ranking", label: "랭킹" },
  { href: "/admin/evidence", label: "근거 설정" },
  { href: "/admin/products", label: "제품" },
] as const;

export function AdminNav({ current }: { current: (typeof PAGES)[number]["href"] }) {
  return (
    <nav className="flex items-center gap-3">
      {PAGES.filter((page) => page.href !== current).map((page) => (
        <Link
          key={page.href}
          href={page.href}
          className="text-[13px] font-semibold text-fg-2 hover:text-fg"
        >
          {page.label}
        </Link>
      ))}
    </nav>
  );
}
