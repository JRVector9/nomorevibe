"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/home/icons";
import { AccountMenu } from "@/components/auth/AccountMenu";
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

/** Mac·iPhone·iPad — 단축키를 ⌘ 로 적는 기기 */
const APPLE_PLATFORM = /Mac|iPhone|iPad|iPod/;

/**
 * 검색창 단축키 표시(A11Y-07) — 실제로는 ⌘K·Ctrl+K 둘 다 듣는다. Windows·Linux 에서 ⌘ 를 보이면 없는 키를 가리킨다.
 * 기기는 브라우저에서만 알 수 있어 서버 HTML 에는 표시를 두지 않고, 붙은 뒤에 그린다(스크립트 없이는 단축키도 없다).
 */
export function shortcutLabel(userAgent: string): string {
  return APPLE_PLATFORM.test(userAgent) ? "⌘K" : "Ctrl K";
}

/** 홈과 분야 주소(/c/[category]) — 목록을 고르는 화면. 검색어 기본값·도구 거르기를 이어 간다 */
function isBrowsePath(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/c/");
}

/** 이 값 중 하나라도 있으면 홈이 아니라 검색·거르기 화면이다 — 메뉴 활성 표시를 끈다(UX-12) */
const FILTER_PARAMS = ["q", "category", "sort", "builder", "observedTool", "ai", "saved"] as const;
/** 이만큼 내려온 뒤부터 검색줄을 접는다 — 첫 화면에서는 늘 보인다 */
const COLLAPSE_AFTER_PX = 120;
/** 이보다 작은 움직임은 방향으로 치지 않는다 — 손가락 떨림·관성 끝자락에 접혔다 펴지지 않게 */
const SCROLL_SLACK_PX = 6;

/** '지금 뜨는' 메뉴 — 활성 표시만 주소의 쿼리에 달려 있다. Suspense 가 기다리는 동안은 표시 없이 같은 링크를 그린다 */
function RisingLink({ active = false }: { active?: boolean }) {
  return <Link prefetch={false} href="/#rising" className={active ? "active" : undefined}>지금 뜨는</Link>;
}

/** 거르기 없는 홈에서만 '지금 뜨는'을 켠다 — 검색 결과·분야 화면에서 켜져 있으면 지금 어디인지 틀리게 말한다 */
function RisingNavLink() {
  const pathname = usePathname();
  const params = useSearchParams();
  return <RisingLink active={pathname === "/" && FILTER_PARAMS.every((name) => !params.has(name))} />;
}

/** 헤더 검색 입력칸. 검색어가 바뀌면 새로 그려 기본값을 다시 채운다(key) */
function SearchInput({ query = "" }: { query?: string }) {
  return (
    <input
      id="search"
      type="search"
      name="q"
      placeholder="프로젝트, 도구, 아이디어 검색"
      aria-label="프로젝트 검색"
      autoComplete="off"
      maxLength={200}
      defaultValue={query}
    />
  );
}

/**
 * 목록 화면에서는 주소의 검색어와 도구 거르기를 서버 HTML 부터 담는다(ROB-03) — 붙기 전 빈 칸이 보이거나,
 * 스크립트 없이 다시 검색하면 도구 거르기가 풀리지 않게. 그 밖의 화면에서는 빈 칸이다.
 */
function SearchFields() {
  const pathname = usePathname();
  const params = useSearchParams();
  const browse = isBrowsePath(pathname);
  const query = browse ? params.get("q") ?? "" : "";
  const observedTool = browse ? params.get("observedTool") : null;
  return (
    <>
      {observedTool && <input type="hidden" name="observedTool" value={observedTool} />}
      <Icon name="search" />
      <SearchInput key={browse ? query : "away"} query={query} />
    </>
  );
}

/**
 * 사이트 헤더. 루트 레이아웃이 Suspense 없이 그린다 — 로고·메뉴·검색창이 첫 HTML 에 바로 있다(PERF-01·ROB-02).
 * 주소의 쿼리(useSearchParams)를 읽는 두 조각만 Suspense 로 감싼다. 정적으로 굳는 화면에서는 그 조각만 기다림 모양으로
 * 나가는데, 기다림 모양도 같은 링크·입력칸이라 자리가 바뀌지 않는다.
 */
export function SiteHeader({ authEnabled = false }: { authEnabled?: boolean }) {
  const router = useRouter();
  const [searching, startSearch] = useTransition();
  const [collapsed, setCollapsed] = useState(false);
  // 단축키 표시는 기기를 알아야 해서 붙은 뒤에만 그린다 — 서버와 첫 클라이언트 그림을 같게 둔다
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrationSnapshot,
    serverHydrationSnapshot,
  );
  const savedRaw = useSyncExternalStore(subscribeSaved, savedSnapshot, () => "[]");
  const hasSaved = parseSaved(savedRaw).size > 0;
  const shortcut = hydrated ? shortcutLabel(navigator.userAgent) : null;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // 검색 입력칸은 Suspense 안에서 바뀔 수 있어 그때그때 찾는다(MobileNav 의 '검색' 탭과 같은 방식)
        const input = document.getElementById("search");
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
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
          <Suspense fallback={<RisingLink />}>
            <RisingNavLink />
          </Suspense>
          <Link prefetch={false} href="/#projects">발견하기</Link>
          <Link prefetch={false} href="/#popular">인기</Link>
          <Link prefetch={false} href="/#new">새로 나온</Link>
        </nav>
        <form
          className="header-search"
          action="/"
          method="get"
          role="search"
          onSubmit={submitSearch}
          aria-busy={searching}
          data-shortcut={shortcut === "Ctrl K" ? "ctrl" : undefined}
        >
          <Suspense fallback={<><Icon name="search" /><SearchInput /></>}>
            <SearchFields />
          </Suspense>
          {searching
            ? <span className="search-spinner" role="status"><span className="sr-only">검색 중</span></span>
            : shortcut && <kbd className="key">{shortcut}</kbd>}
        </form>
        <button type="button" className="saved-nav" onClick={openSaved} aria-label="저장한 프로젝트">
          <Icon name="bookmark" />
          <i className={`saved-dot${hasSaved ? " on" : ""}`} />
        </button>
        {authEnabled && <AccountMenu />}
        <Link className="primary" href="/launch">프로젝트 공개</Link>
      </div>
    </header>
  );
}
