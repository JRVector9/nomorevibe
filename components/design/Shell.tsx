"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { href, screens } from "./data";
import { useDemo, resetDemo } from "./store";
import { Icon, Empty, Notice } from "./ui";
export function DesignShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const search = useRef<HTMLInputElement>(null);
  const [view, setView] = useState("normal");
  const [mobileSearch, setMobileSearch] = useState(false);
  const { storageError } = useDemo();
  useEffect(() => {
    if (mobileSearch) search.current?.focus();
  }, [mobileSearch]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMobileSearch(true);
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  return (
    <div className="nmv-design">
      <div className="d-preview">
        <span>
          <span className="d-live-dot" /> 디자인 미리보기{" "}
          <span className="d-muted">· 예시 데이터 · 이 브라우저에만 저장</span>
        </span>
        <details className="d-screen-picker">
          <summary>
            화면 목록 <Icon name="grid" size={14} />
          </summary>
          <nav aria-label="화면 목록">
            {screens.map(([id, title, path]) => (
              <Link
                key={path}
                href={href(path)}
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  setView("normal");
                }}
              >
                <small>{id}</small>
                {title}
              </Link>
            ))}
          </nav>
        </details>
      </div>
      <header className="d-site-header">
        <Link className="d-brand" href={href()}>
          nomorevibe<span className="d-brand-dot">.</span>
        </Link>
        <nav aria-label="주 메뉴">
          {[
            ["launches", "Launches"],
            ["radar", "Radar"],
            ["missions", "Feedback"],
          ].map(([path, label]) => (
            <Link
              key={path}
              href={href(path)}
              aria-current={pathname === href(path) ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form
          className={`d-search ${mobileSearch ? "open" : ""}`}
          id="design-search"
          onSubmit={(e) => {
            e.preventDefault();
            setMobileSearch(false);
            router.push(
              href(pathname === href("radar") ? "radar" : "launches") +
                "?q=" +
                encodeURIComponent(search.current?.value ?? ""),
            );
          }}
        >
          <Icon name="search" size={17} />
          <input
            ref={search}
            aria-label="제품 검색"
            placeholder="제품, 도구, 아이디어 검색"
            maxLength={100}
          />
          <kbd>⌘ K</kbd>
        </form>
        <button
          className="d-mobile-search d-header-icon"
          aria-label="검색창 열기"
          aria-expanded={mobileSearch}
          aria-controls="design-search"
          onClick={() => setMobileSearch((open) => !open)}
        >
          <Icon name="search" />
        </button>
        <Link
          className="d-header-icon"
          href={href("notifications")}
          aria-label="알림"
        >
          <Icon name="bell" />
        </Link>
        <Link
          className="d-header-profile"
          href={href("dashboard")}
          aria-label="빌더 대시보드"
        >
          J
        </Link>
        <Link className="d-button d-header-launch" href={href("launch")}>
          제품 등록 <Icon name="plus" size={16} />
        </Link>
      </header>
      <main className="d-main" id="design-main">
        {storageError && (
          <Notice tone="amber">
            브라우저 저장 공간을 사용할 수 없어 새로고침하면 입력이 사라질 수
            있습니다.
          </Notice>
        )}
        {view === "loading" ? (
          <div className="d-loading" role="status" aria-label="불러오는 중">
            <div />
            <div />
            <div />
            <p>제품을 불러오는 중입니다.</p>
          </div>
        ) : view === "empty" ? (
          <Empty
            title="조건에 맞는 제품이 없어요"
            body="필터를 바꾸거나 새로운 제품을 둘러보세요."
            action={
              <button
                className="d-button secondary"
                onClick={() => setView("normal")}
              >
                필터 초기화
              </button>
            }
          />
        ) : view === "error" ? (
          <Empty
            title="잠시 불러오지 못했어요"
            body="입력한 내용은 유지됩니다. 잠시 후 다시 시도해주세요."
            action={
              <button className="d-button" onClick={() => setView("normal")}>
                다시 시도
              </button>
            }
          />
        ) : view === "forbidden" ? (
          <Empty
            title="접근 권한을 확인해주세요"
            body="제품 관리 기능은 권한이 확인된 메이커와 팀원에게 제공됩니다."
            action={
              <button
                className="d-button secondary"
                onClick={() => setView("normal")}
              >
                제품으로 돌아가기
              </button>
            }
          />
        ) : (
          <>
            {view === "partial" && (
              <Notice>
                일부 정보를 불러오지 못했습니다. 확인하지 못한 지표는 표시하지
                않습니다.
              </Notice>
            )}
            {view === "stale" && (
              <Notice tone="amber">
                마지막 확인 이후 정보가 바뀌었을 수 있습니다. 최신 상태 확인을
                기다리고 있습니다.
              </Notice>
            )}
            {view === "pending" && (
              <Notice>
                제출된 내용을 검토 중입니다. 결과가 나오면 알림으로
                알려드립니다.
              </Notice>
            )}
            {children}
          </>
        )}
      </main>
      <footer className="d-footer">
        <div>
          <Link className="d-brand" href={href()}>
            nomorevibe.
          </Link>
          <span>Build something. Ship it. Improve it.</span>
        </div>
        <nav aria-label="하단 메뉴">
          {[
            ["credits/how-it-works", "Credits"],
            ["pricing", "Pricing"],
            ["trust", "Trust"],
            ["me", "내 활동"],
          ].map(([p, t]) => (
            <Link key={p} href={href(p)}>
              {t}
            </Link>
          ))}
        </nav>
      </footer>
      <div className="d-review-tools">
        <span>화면 검토</span>
        <label>
          상태{" "}
          <select
            aria-label="화면 상태"
            value={view}
            onChange={(e) => setView(e.target.value)}
          >
            {[
              ["normal", "기본"],
              ["loading", "로딩"],
              ["empty", "빈 상태"],
              ["error", "오류"],
              ["forbidden", "권한 없음"],
              ["partial", "일부 데이터 없음"],
              ["stale", "오래된 데이터"],
              ["pending", "검토 중"],
            ].map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            if (
              window.confirm("이 디자인 미리보기의 입력과 활동만 초기화할까요?")
            ) {
              resetDemo();
              setView("normal");
              router.push(href());
            }
          }}
        >
          예시 데이터 초기화
        </button>
      </div>
      <nav className="d-mobile-nav" aria-label="모바일 메뉴">
        {[
          ["", "grid", "홈"],
          ["launches", "rocket", "Launches"],
          ["radar", "radar", "Radar"],
          ["missions", "feedback", "미션"],
          ["dashboard", "user", "내 제품"],
        ].map(([p, i, t]) => (
          <Link
            key={p}
            href={href(p)}
            aria-current={pathname === href(p) ? "page" : undefined}
          >
            <Icon name={i} size={20} />
            {t}
          </Link>
        ))}
      </nav>
    </div>
  );
}
