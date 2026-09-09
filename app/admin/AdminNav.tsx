import Link from "next/link";

const PAGES = [
  { href: "/admin/status", label: "운영센터", hint: "서비스·작업 현황" },
  { href: "/admin/review", label: "심사 큐", hint: "후보 검토·승인" },
  { href: "/admin/products", label: "제품 관리", hint: "목록·제품 근거" },
  { href: "/admin", label: "크롤 설정", hint: "수집 규칙·검색 신호" },
  { href: "/admin/categories", label: "카테고리 기준", hint: "분류 정의·예시" },
  { href: "/admin/evidence", label: "근거 설정", hint: "출처·갱신 정책" },
  { href: "/admin/ranking", label: "랭킹", hint: "집계·시즌 정책" },
] as const;

export function AdminNav({ current }: { current: string }) {
  return (
    <nav className="admin-navigation" aria-label="관리자 메뉴">
      {PAGES.map((page) => {
        const active = current === page.href || (page.href !== "/admin" && current.startsWith(`${page.href}/`));
        return <Link key={page.href} href={page.href} aria-current={active ? "page" : undefined} prefetch={false}>
          <span>{page.label}</span><small>{page.hint}</small>
        </Link>;
      })}
    </nav>
  );
}
