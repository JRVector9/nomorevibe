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
  const news = hydrated && pathname.startsWith("/news");

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
      <div className="wrap">
        <Link className="brand" href="/" aria-label="nomorevibe 홈">
          <span className="brand-symbol" aria-hidden="true">✳</span>
          nomorevibe
          <span className="brand-beta">BETA</span>
        </Link>
        <nav className="navigation" aria-label="주 메뉴">
          <Link href="/" className={home ? "active" : undefined}>발견하기</Link>
          <Link href="/news" className={news ? "active" : undefined}>AI 소식</Link>
          <Link href="/?metric=tools">제작 도구</Link>
        </nav>
        <form className="header-search" action="/" method="get">
          {home && params.get("sort") && <input type="hidden" name="sort" value={params.get("sort") ?? ""} />}
          {home && params.get("category") && <input type="hidden" name="category" value={params.get("category") ?? ""} />}
          {home && params.get("builder") && <input type="hidden" name="builder" value={params.get("builder") ?? ""} />}
          <Icon name="search" />
          <input
            ref={input}
            id="search"
            type="search"
            name="q"
            placeholder="프로젝트, 도구, 아이디어 검색"
            aria-label="프로젝트 검색"
            autoComplete="off"
            defaultValue={home ? params.get("q") ?? "" : ""}
            key={home ? params.get("q") ?? "" : "away"}
          />
          <kbd className="key">⌘ K</kbd>
        </form>
        <div className="header-right">
          <button type="button" className="saved-nav" onClick={openSaved} aria-label="저장한 프로젝트">
            <Icon name="bookmark" />
            <i className={`saved-dot${hasSaved ? " on" : ""}`} />
          </button>
          <Link className="primary" href="/launch">
            <Icon name="plus" size={15} />
            프로젝트 공개
          </Link>
        </div>
      </div>
    </header>
  );
}
