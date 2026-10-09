"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "@/components/home/icons";

/** '인기' 탭 아이콘 — 트로피. 발견(격자)과 같은 그림을 쓰면 두 탭이 구분되지 않았다(UX-26) */
function TrophyIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 6H4.5a2.5 2.5 0 0 0 2.6 3.6M17 6h2.5a2.5 2.5 0 0 1-2.6 3.6" />
      <path d="M12 14v4M8.5 20h7" />
    </svg>
  );
}

/**
 * 좁은 화면의 아래 탭 — 발견·검색·인기·저장(UX-26).
 * '공개'는 뺐다 — 헤더 첫 줄의 '프로젝트 공개' 버튼이 늘 보인다. 검색은 헤더의 검색창으로 초점을 옮긴다(접혀 있으면 펴진다).
 */
export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname.startsWith("/admin")) return null;

  function openSaved() {
    router.push("/?saved=1#projects");
  }

  function focusSearch() {
    const input = document.getElementById("search");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  }

  const discover = pathname === "/" || pathname.startsWith("/c/");
  const popular = pathname.startsWith("/popular");

  return (
    <nav className="mobile-bottom" aria-label="모바일 탐색">
      <Link prefetch={false} href="/" className={discover ? "active" : undefined}>
        <Icon name="grid" />
        발견
      </Link>
      <button type="button" onClick={focusSearch}>
        <Icon name="search" />
        검색
      </button>
      <Link prefetch={false} href="/popular" className={popular ? "active" : undefined}>
        <TrophyIcon />
        인기
      </Link>
      <button type="button" onClick={openSaved}>
        <Icon name="bookmark" />
        저장
      </button>
    </nav>
  );
}
