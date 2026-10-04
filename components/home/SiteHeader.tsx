"use client";

import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/home/icons";
import { parseSaved, savedSnapshot, subscribeSaved } from "@/components/home/saved";

function subscribeHydration(): () => void {
  return () => {};
}

function clientHydrationSnapshot(): boolean {
  return true;
}

function serverHydrationSnapshot(): boolean {
  return false;
}

export function SiteHeader() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  // A route can change before the root layout finishes hydrating. Keep the first
  // client tree identical to SSR, then apply the live pathname/query snapshot.
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrationSnapshot,
    serverHydrationSnapshot,
  );
  const savedRaw = useSyncExternalStore(subscribeSaved, savedSnapshot, () => "[]");
  const hasSaved = parseSaved(savedRaw).size > 0;
  const home = hydrated && pathname === "/";

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function openSaved() {
    router.push("/?saved=1#projects");
  }

  return (
    <header className="nmb-header">
      <div className="wrap header-row">
        <Link className="brand" href="/" aria-label="nomorevibe 홈">
          <i className="brand-dot" aria-hidden="true" />
          nomorevibe
        </Link>
        <nav className="navigation" aria-label="주 메뉴">
          <Link href="/#rising" className={home ? "active" : undefined}>급상승</Link>
          <Link href="/#projects">발견하기</Link>
          <Link href="/#popular">인기</Link>
          <Link href="/#new">새로 나온</Link>
        </nav>
        <form className="header-search" action="/" method="get" role="search">
          {home && params.get("observedTool") && <input type="hidden" name="observedTool" value={params.get("observedTool")!} />}
          <Icon name="search" />
          <input
            ref={input}
            id="search"
            type="search"
            name="q"
            placeholder="프로젝트, 도구, 아이디어 검색"
            aria-label="프로젝트 검색"
            autoComplete="off"
            maxLength={200}
            defaultValue={home ? params.get("q") ?? "" : ""}
            key={home ? params.get("q") ?? "" : "away"}
          />
          <kbd className="key">⌘K</kbd>
        </form>
        <button type="button" className="saved-nav" onClick={openSaved} aria-label="저장한 프로젝트">
          <Icon name="bookmark" />
          <i className={`saved-dot${hasSaved ? " on" : ""}`} />
        </button>
        <Link className="primary" href="/launch">프로젝트 공개</Link>
      </div>
    </header>
  );
}
