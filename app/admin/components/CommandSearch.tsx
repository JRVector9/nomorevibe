"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { AdminSearchResult } from "@/lib/operations/admin-search";
import { ADMIN_SEARCH_MIN } from "@/lib/operations/admin-search";
import { AdminIcon } from "./AdminIcon";

/** 상태 이름 — 제품 표(ProductRow)·심사 상세(ReviewDetail)와 같은 말 */
const PRODUCT_STATUS: Record<string, string> = { verified: "검증됨", seeded: "미클레임", unverified: "검증 대기", banned: "차단됨" };
const CANDIDATE_STATE: Record<string, string> = { new: "규칙 검사 대기", approved: "발행 조건 확인", needs_review: "보류", rejected: "거부", published: "발행 완료" };
const WAIT_MS = 200;

type Item = { key: string; href: string; title: string; detail: string; badge: string; extra?: { label: string; href: string }[] };

/** 결과를 화살표로 오가는 한 줄 목록으로 — 묶음(제품·후보·기록) 차례 그대로 */
export function searchItems(result: AdminSearchResult | null): { group: string; items: Item[] }[] {
  if (!result) return [];
  return [
    { group: "제품", items: result.products.map((p) => ({ key: `p:${p.slug}`, href: p.href, title: p.name, detail: p.repoUrl?.replace(/^https:\/\/github\.com\//, "") ?? p.url.replace(/^https?:\/\//, ""),
      badge: PRODUCT_STATUS[p.status] ?? p.status, extra: [{ label: "공개 페이지", href: p.publicHref }, { label: "기록", href: p.logHref }] })) },
    { group: "심사 후보", items: result.candidates.map((c) => ({ key: `c:${c.id}`, href: c.href, title: c.repo, detail: c.productUrl?.replace(/^https?:\/\//, "") ?? "배포 주소 없음",
      badge: CANDIDATE_STATE[c.state] ?? c.state, extra: [{ label: "기록", href: c.logHref }] })) },
    { group: "작업 로그 대상", items: result.targets.map((t) => ({ key: `t:${t.target}`, href: t.href, title: t.target, detail: `${t.count.toLocaleString("ko-KR")}건`, badge: "기록" })) },
  ].filter((section) => section.items.length > 0);
}

/**
 * 관리자 전역 검색(⌘K·Ctrl+K, 2026-10-08 UX 점검 ADM-05) — 사이드바 맨 위 단추나 단축키로 연다.
 * 제품 이름·slug·주소·저장소, 후보 저장소·배포 주소, 작업 로그 대상을 한 창에서 찾고, 줄을 고르면 그 화면으로 간다.
 * 화살표로 줄을 옮기고 Enter 로 연다. 줄 끝의 작은 링크(공개 페이지·기록)는 마우스로 고른다.
 */
export function CommandSearch() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<AdminSearchResult | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [active, setActive] = useState(0);
  const sections = searchItems(result);
  const items = sections.flatMap((section) => section.items);

  const open = () => {
    if (!dialog.current?.open) dialog.current?.showModal();
    input.current?.select();
  };
  const go = (href: string) => {
    dialog.current?.close();
    router.push(href);
  };

  // ⌘K·Ctrl+K — 어느 관리자 화면에서든. 글을 쓰는 칸에서도 연다(다른 단축키와 겹치지 않는다)
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "k" || event.key === "K" || event.code === "KeyK")) {
      event.preventDefault();
      open();
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // 글자가 멈추면 묻는다 — 앞선 요청은 끊는다
  useEffect(() => {
    const term = query.trim();
    if ([...term].length < ADMIN_SEARCH_MIN) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState("loading");
      try {
        const response = await fetch(`/admin/search?q=${encodeURIComponent(term)}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        setResult(await response.json() as AdminSearchResult);
        setActive(0);
        setState("idle");
      } catch (error) {
        if (!controller.signal.aborted) setState("error");
        void error;
      }
    }, WAIT_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  const short = [...query.trim()].length < ADMIN_SEARCH_MIN;
  const shown = short ? [] : sections;
  const activeItem = short ? null : items[active];

  return <>
    <button type="button" className="admin-search-trigger" onClick={open} aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" title="제품·후보·작업 로그 찾기 (⌘K)">
      <AdminIcon name="search" size={15} /><span className="admin-sidebar-label">찾기</span><kbd className="admin-sidebar-label">⌘K</kbd>
    </button>
    <dialog ref={dialog} className="admin-confirm admin-search" aria-label="관리자 전역 검색"
      onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="admin-search-body">
        <div className="admin-search-field">
          <AdminIcon name="search" size={16} />
          <input ref={input} type="search" value={query} autoFocus placeholder="제품 이름·slug·주소·저장소, 후보, 작업 로그 대상"
            role="combobox" aria-expanded={items.length > 0 && !short} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={activeItem ? `${listId}-${activeItem.key}` : undefined} aria-label="찾을 말"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && items.length) { event.preventDefault(); setActive((active + 1) % items.length); }
              else if (event.key === "ArrowUp" && items.length) { event.preventDefault(); setActive((active - 1 + items.length) % items.length); }
              else if (event.key === "Enter" && activeItem) { event.preventDefault(); go(activeItem.href); }
            }} />
          <button type="button" className="admin-search-close" onClick={() => dialog.current?.close()} aria-label="닫기"><AdminIcon name="close" size={14} /></button>
        </div>
        <div id={listId} role="listbox" aria-label="찾은 것" className="admin-search-results">
          {shown.map((section) => (
            <div key={section.group} role="group" aria-label={section.group}>
              <p className="admin-search-group">{section.group}</p>
              {section.items.map((item) => {
                const index = items.indexOf(item);
                return (
                  <div key={item.key} id={`${listId}-${item.key}`} role="option" aria-selected={index === active}
                    className="admin-search-item" onMouseMove={() => { if (index !== active) setActive(index); }}
                    onClick={(event) => { if (!(event.target as Element).closest("a")) go(item.href); }}>
                    <span className="admin-search-title">{item.title}</span>
                    <span className="admin-search-badge">{item.badge}</span>
                    <span className="admin-search-detail">{item.detail}</span>
                    {item.extra && <span className="admin-search-extra">
                      {item.extra.map((link) => <a key={link.label} href={link.href} tabIndex={-1} onClick={(event) => { event.preventDefault(); go(link.href); }}>{link.label}</a>)}
                    </span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <p className="admin-search-note" aria-live="polite">
          {short ? `${ADMIN_SEARCH_MIN}글자 이상 입력하면 찾습니다. ↑↓ 로 옮기고 Enter 로 엽니다.`
            : state === "loading" ? "찾는 중…"
            : state === "error" ? "찾지 못했습니다 — 잠시 뒤 다시 입력해 주세요."
            : result && items.length === 0 ? `“${result.q}”에 맞는 제품·후보·기록이 없습니다.`
            : `${items.length}건 · ↑↓ 로 옮기고 Enter 로 엽니다.`}
        </p>
      </div>
    </dialog>
  </>;
}
