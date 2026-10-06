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
      <Link prefetch={false} href="/" className={pathname === "/" ? "active" : undefined}>
        <Icon name="grid" />
        발견
      </Link>
      <Link prefetch={false} href="/#popular">
        <Icon name="grid" />
        인기
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
