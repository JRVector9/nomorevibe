"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/home/icons";
import { parseSaved, savedSnapshot, subscribeSaved } from "@/components/home/saved";
import { BRAND } from "@/lib/copy/brand";
import "./chrome.css";

function subscribeHydration(): () => void {
  return () => {};
}

function clientHydrationSnapshot(): boolean {
  return true;
}

function serverHydrationSnapshot(): boolean {
  return false;
}

/** 이 값 중 하나라도 있으면 홈이 아니라 검색·거르기 화면이다 — 메뉴 활성 표시를 끈다(UX-12) */
const FILTER_PARAMS = ["q", "category", "sort", "builder", "observedTool", "ai", "saved"] as const;
/** 이만큼 내려온 뒤부터 검색줄을 접는다 — 첫 화면에서는 늘 보인다 */
const COLLAPSE_AFTER_PX = 120;
/** 이보다 작은 움직임은 방향으로 치지 않는다 — 손가락 떨림·관성 끝자락에 접혔다 펴지지 않게 */
const SCROLL_SLACK_PX = 6;

export function SiteHeader() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [searching, startSearch] = useTransition();
  const [collapsed, setCollapsed] = useState(false);
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
  /** 목록을 고르는 화면 — 홈과 분야 주소(/c/[category]). 검색어 기본값·도구 거르기를 이어 간다 */
  const browse = hydrated && (pathname === "/" || pathname.startsWith("/c/"));
  /** 거르기 없는 홈 — 검색 결과·분야 화면에서 '지금 뜨는'이 켜져 있으면 지금 어디인지 틀리게 말한다 */
  const bareHome = home && FILTER_PARAMS.every((name) => !params.has(name));

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

  /**
   * 좁은 화면에서 아래로 스크롤하면 검색줄을 접고 위로 올리면 편다(UX-26). 접는 모양은 chrome.css 가 정한다 —
   * 넓은 화면에서는 이 값이 아무것도 바꾸지 않는다. 한 프레임에 한 번만 읽는다.
   */
  useEffect(() => {
    let last = window.scrollY;
    let frame = 0;
    function update() {
      frame = 0;
      const y = window.scrollY;
      if (Math.abs(y - last) < SCROLL_SLACK_PX) return;
      setCollapsed(y > last && y > COLLAPSE_AFTER_PX);
      last = y;
    }
    function onScroll() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  function openSaved() {
    router.push("/?saved=1#projects");
  }

  /**
   * 검색은 앱 안에서 이동한다 — 그동안 입력창 오른쪽에 도는 표시를 띄운다(UX-38). 의미 검색은 1~2초 걸리는데
   * 폼 제출로 새로 불러오면 그 사이 화면에 아무 반응이 없었다. 스크립트가 아직 없으면 폼이 그대로 GET 으로 간다.
   */
  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string") query.append(name, value);
    }
    startSearch(() => router.push(`/?${query}`));
  }

  return (
    <header className="nmb-header" data-collapsed={collapsed || undefined}>
      <div className="wrap header-row">
        <Link prefetch={false} className="brand" href="/" aria-label={`${BRAND} 홈`}>
          <i className="brand-dot" aria-hidden="true" />
          {BRAND}
        </Link>
        <nav className="navigation" aria-label="주 메뉴">
          <Link prefetch={false} href="/#rising" className={bareHome ? "active" : undefined}>지금 뜨는</Link>
          <Link prefetch={false} href="/#projects">발견하기</Link>
          <Link prefetch={false} href="/#popular">인기</Link>
          <Link prefetch={false} href="/#new">새로 나온</Link>
        </nav>
        <form className="header-search" action="/" method="get" role="search" onSubmit={submitSearch} aria-busy={searching}>
          {browse && params.get("observedTool") && <input type="hidden" name="observedTool" value={params.get("observedTool")!} />}
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
            defaultValue={browse ? params.get("q") ?? "" : ""}
            key={browse ? params.get("q") ?? "" : "away"}
          />
          {searching
            ? <span className="search-spinner" role="status"><span className="sr-only">검색 중</span></span>
            : <kbd className="key">⌘K</kbd>}
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
