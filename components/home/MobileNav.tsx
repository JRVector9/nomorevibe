"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "@/components/home/icons";

export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname.startsWith("/admin")) return null;

  function openSaved() {
    router.push("/?saved=1#projects");
  }

  return (
    <nav className="mobile-bottom" aria-label="모바일 탐색">
      <Link href="/" className={pathname === "/" ? "active" : undefined}>
        <Icon name="grid" />
        발견
      </Link>
      <Link href="/news" className={pathname.startsWith("/news") ? "active" : undefined}>
        <Icon name="news" />
        AI 소식
      </Link>
      <button type="button" onClick={openSaved}>
        <Icon name="bookmark" />
        저장
      </button>
      <Link href="/launch">
        <Icon name="plus" />
        공개
      </Link>
    </nav>
  );
}
