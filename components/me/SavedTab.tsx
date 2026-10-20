"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ProductIcon } from "@/components/ProductIcon";
import { ProductTagline } from "@/components/ProductTagline";
import { translatedCategory } from "@/components/home/i18n";
import { Icon } from "@/components/home/icons";
import { ProjectCard } from "@/components/home/ProjectCard";
import { toggleSaved } from "@/components/home/saved";
import { SavedMergePrompt, savedNoticeText } from "@/components/home/SavedToast";
import { useSavedAccount, useSavedSlugs } from "@/components/home/useSavedSlugs";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import type { SavedAccountItem, SavedFilter, SavedItem, SavedPage, SavedSort } from "@/lib/me/saved";
import "./saved.css";

const SORTS: SavedSort[] = ["recent", "stars", "activity"];
const FILTERS: SavedFilter[] = ["all", "untried"];
/** 한 번에 그리는 수(lib/me/saved.ts SAVED_PAGE_SIZE)·로그아웃 카드를 한 번에 받는 수(api/product-summaries 상한) */
const PAGE_SIZE = 24;
const SUMMARY_CHUNK = 100;
/** 빼기 되돌리기는 5초(시안 3.1) */
const UNDO_MS = 5_000;

type Query = { sort: SavedSort; filter: SavedFilter; category: string | null };
const DEFAULT_QUERY: Query = { sort: "recent", filter: "all", category: null };
type Removed<T> = { item: T; index: number };

const noop = () => () => {};

/** 카드 덮개 아래 따로 눌리는 저장 빼기 — 휴대폰 한 줄 행 */
function SavedRow({ item, onRemove, children }: { item: SavedItem; onRemove: () => void; children?: ReactNode }) {
  const locale = useLocale();
  const t = useTranslations("labels");
  const icon = item.ogImage?.startsWith("/") && !item.ogImage.startsWith("//") ? item.ogImage : null;
  return (
    <li className="me-srow">
      <span className="me-srow-icon" aria-hidden="true"><ProductIcon name={item.name} ogImage={icon} size={44} category={item.category} /></span>
      <div className="me-srow-body">
        <h3 className="me-srow-name"><Link prefetch={false} href={localePath(locale, `/p/${item.slug}`)} className="card-link">{item.name}</Link></h3>
        <ProductTagline translation={item.translation} tagline={item.tagline} taglineKo={item.taglineKo} source={item.taglineSource} className="me-srow-tagline" showSource={false} />
        {children}
      </div>
      <button type="button" className="cover-saved active" aria-pressed="true" aria-label={t("card.unsave", { name: item.name })} onClick={onRemove}>
        <Icon name="bookmark" size={16} />
      </button>
    </li>
  );
}

/** 카드 아래 한 줄 — 써봤는지·저장한 날(시안 pmine). 응답 없음은 휴대폰 행에서만(카드는 메타 줄에 이미 있다) */
function SavedMine({ item, row = false }: { item: SavedAccountItem; row?: boolean }) {
  const t = useTranslations("me");
  const labels = useTranslations("labels");
  const locale = useLocale();
  const now = useServerNow();
  return (
    <p className="me-saved-mine">
      <span className={`me-verdict${item.tried ? " tried" : ""}`}>{t(item.tried ? "saved.tried" : "saved.untried")}</span>
      {row && item.health?.down && <span className="meta-down">{labels("card.down")}</span>}
      <span>{t("saved.savedOn", { date: formatDate(item.savedAt, now, locale) })}</span>
    </p>
  );
}

/** PC 는 운영 카드(ProjectCard) 세 칸, 휴대폰은 한 줄 행 — 화면 폭으로 하나만 보인다(saved.css) */
function SavedList<T extends SavedItem>({ items, onRemove, mine }: { items: T[]; onRemove: (item: T) => void; mine?: (item: T, row: boolean) => ReactNode }) {
  const now = useServerNow();
  return (
    <>
      <div className="me-saved-cards">
        {items.map((item) => (
          <ProjectCard key={item.slug} product={item} saved onToggleSave={() => onRemove(item)} now={now}>{mine?.(item, false)}</ProjectCard>
        ))}
      </div>
      <ul className="me-saved-rows">
        {items.map((item) => <SavedRow key={item.slug} item={item} onRemove={() => onRemove(item)}>{mine?.(item, true)}</SavedRow>)}
      </ul>
    </>
  );
}

/**
 * 빼기 되돌리기·동기화 알림 — 화면 아래 한 줄. 되돌리기가 먼저다.
 * 알림 영역(role=status)은 늘 그려 두고 글만 바꾼다(처음 끼운 영역은 읽지 않는 화면 읽기 도구가 있다).
 * 빼면 초점을 «되돌리기»로 옮기고, 그 위에 마우스나 초점이 있는 동안은 사라지지 않는다.
 */
function SavedTabToast({ removed, onUndo, onHold }: { removed: string | null; onUndo: () => void; onHold: (held: boolean) => void }) {
  const t = useTranslations("me");
  const common = useTranslations("common");
  const locale = useLocale();
  const { notice } = useSavedAccount();
  const undo = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (removed) undo.current?.focus();
  }, [removed]);
  const visible = Boolean(removed || notice);
  return (
    <div role="status">
      {visible && <div className="saved-toast" onMouseEnter={() => onHold(true)} onMouseLeave={() => onHold(false)}
        onFocus={() => onHold(true)} onBlur={() => onHold(false)}>
        <div className="saved-toast-row">
          <p>{removed ? t("saved.removed", { name: removed }) : savedNoticeText(notice!, common, locale)}</p>
          {removed && <button ref={undo} type="button" className="saved-toast-action" onClick={onUndo}>{t("saved.undo")}</button>}
        </div>
      </div>}
    </div>
  );
}

function useUndo<T extends SavedItem>(): [Removed<T> | null, (value: Removed<T> | null) => void, (held: boolean) => void] {
  const [removed, setRemoved] = useState<Removed<T> | null>(null);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!removed || held) return;
    const timer = setTimeout(() => setRemoved(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [removed, held]);
  return [removed, (value) => { setHeld(false); setRemoved(value); }, setHeld];
}

/** 첫 행동 하나 — 인기 프로젝트 둘러보기 */
function SavedEmpty({ body, hint }: { body: string; hint?: string }) {
  const t = useTranslations("me");
  const locale = useLocale();
  return (
    <div className="empty-state me-saved-empty">
      <Icon name="bookmark" size={29} />
      <h3>{t("saved.empty.title")}</h3>
      <p>{body}</p>
      <Link prefetch={false} className="me-cta" href={localePath(locale, "/popular")}>{t("saved.empty.cta")}</Link>
      {hint && <p className="me-saved-hint">{hint}</p>}
    </div>
  );
}

/** 지우거나 되돌린 한 장만큼 수를 고친다 — 다시 받지 않는다 */
function adjust(page: SavedPage, item: SavedAccountItem, delta: 1 | -1, items: SavedAccountItem[]): SavedPage {
  return {
    ...page,
    items,
    total: page.total + delta,
    counts: { all: page.counts.all + delta, untried: page.counts.untried + (item.tried ? 0 : delta) },
    categories: page.categories.map((entry) => entry.key === item.category ? { ...entry, count: entry.count + delta } : entry),
  };
}

/** 로그인한 사람의 저장 탭 — 계정 목록(GET /api/me/saved), 거르기·분야·정렬, 빼기 되돌리기, 더 보기(커서) */
export function SavedAccountList({ initial }: { initial: SavedPage | null }) {
  const t = useTranslations("me");
  const labels = useTranslations("labels");
  const locale = useLocale();
  const account = useSavedAccount();
  const [query, setQuery] = useState<Query>(DEFAULT_QUERY);
  const [page, setPage] = useState<SavedPage | null>(initial);
  // 서버가 첫 쪽을 못 읽었으면 다시 시도 단추부터
  const [status, setStatus] = useState<"ready" | "loading" | "more" | "error">(initial ? "ready" : "error");
  const [removed, setRemoved, holdUndo] = useUndo<SavedAccountItem>();
  const request = useRef<AbortController | null>(null);
  const count = (value: number) => formatNumber(value, locale);

  async function load(next: Query, cursor?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setStatus(cursor ? "more" : "loading");
    const params = new URLSearchParams({ sort: next.sort, filter: next.filter, locale });
    if (next.category) params.set("category", next.category);
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await fetch(`/api/me/saved?${params}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as SavedPage;
      setPage((current) => cursor && current
        ? { ...body, items: [...current.items, ...body.items.filter((item) => !current.items.some((entry) => entry.slug === item.slug))] }
        : body);
      setStatus("ready");
    } catch {
      if (!controller.signal.aborted) setStatus("error");
    }
  }

  function change(patch: Partial<Query>) {
    const next = { ...query, ...patch };
    setQuery(next);
    setRemoved(null);
    void load(next);
  }

  function remove(item: SavedAccountItem) {
    if (!page) return;
    const index = page.items.findIndex((entry) => entry.slug === item.slug);
    toggleSaved(item.slug, false);
    setPage(adjust(page, item, -1, page.items.filter((entry) => entry.slug !== item.slug)));
    setRemoved({ item, index });
  }

  function undo() {
    if (!removed || !page) return;
    toggleSaved(removed.item.slug, true);
    const items = [...page.items];
    items.splice(Math.min(removed.index, items.length), 0, removed.item);
    setPage(adjust(page, removed.item, 1, items));
    setRemoved(null);
  }

  const offer = account.status === "user" && account.offer > 0
    ? <SavedMergePrompt className="me-saved-merge" count={account.offer} onMerged={() => void load(query)} />
    : null;
  const toast = <SavedTabToast removed={removed ? removed.item.name : null} onUndo={undo} onHold={holdUndo} />;

  if (!page) {
    return (
      <section className="me-saved" aria-labelledby="me-saved-title">
        <h2 id="me-saved-title" className="sr-only">{t("saved.title")}</h2>
        {offer}
        {status === "error"
          ? <p className="me-saved-status" role="alert">{t("saved.error")} <button type="button" className="text-button" onClick={() => void load(query)}>{t("saved.retry")}</button></p>
          : <p className="me-saved-status" role="status">{t("saved.loading")}</p>}
      </section>
    );
  }

  const filtered = query.filter !== "all" || query.category !== null;
  if (!filtered && page.counts.all === 0 && !removed) {
    return (
      <section className="me-saved" aria-labelledby="me-saved-title">
        <h2 id="me-saved-title" className="sr-only">{t("saved.title")}</h2>
        {offer}
        <SavedEmpty body={t("saved.empty.body")} hint={t("saved.empty.hint")} />
        {toast}
      </section>
    );
  }

  const categories = page.categories.filter((entry) => entry.count > 0 || entry.key === query.category);
  return (
    <section className="me-saved" aria-labelledby="me-saved-title" aria-busy={status === "loading"}>
      <h2 id="me-saved-title" className="sr-only">{t("saved.title")}</h2>
      {offer}
      <div className="me-saved-tools">
        <div className="me-chip-row">
          <div className="me-chip-group" role="group" aria-label={t("saved.filterLabel")}>
            {FILTERS.map((filter) => (
              <button key={filter} type="button" className={`chip${query.filter === filter ? " chip-dark" : ""}`} aria-pressed={query.filter === filter} onClick={() => change({ filter })}>
                {t(`saved.filter.${filter}`)} <span className="chip-count">{count(filter === "all" ? page.counts.all : page.counts.untried)}</span>
              </button>
            ))}
          </div>
          {categories.length > 1 || query.category ? (
            <>
              <span className="me-chip-sep" aria-hidden="true" />
              <div className="me-chip-group" role="group" aria-label={t("saved.categoryLabel")}>
                {categories.map((entry) => (
                  <button key={entry.key} type="button" className={`chip${query.category === entry.key ? " chip-dark" : ""}`} aria-pressed={query.category === entry.key}
                    onClick={() => change({ category: query.category === entry.key ? null : entry.key })}>
                    {translatedCategory(entry.key, labels)} <span className="chip-count">{count(entry.count)}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <p className="me-saved-note">{t("saved.synced")}</p>
        <label className="me-sort">
          <span className="sr-only">{t("saved.sortLabel")}</span>
          <select value={query.sort} onChange={(event) => change({ sort: event.target.value as SavedSort })}>
            {SORTS.map((sort) => <option key={sort} value={sort}>{t(`saved.sort.${sort}`)}</option>)}
          </select>
        </label>
      </div>
      {status === "error" && <p className="me-saved-status" role="alert">{t("saved.error")} <button type="button" className="text-button" onClick={() => void load(query)}>{t("saved.retry")}</button></p>}
      {page.items.length === 0 && status !== "loading" ? (
        <p className="me-saved-status">{t("saved.filterEmpty")} <button type="button" className="text-button" onClick={() => change({ filter: "all", category: null })}>{t("saved.clearFilter")}</button></p>
      ) : (
        <SavedList items={page.items} onRemove={remove} mine={(item, row) => <SavedMine item={item} row={row} />} />
      )}
      {page.nextCursor && (
        <button type="button" className="more-btn" disabled={status === "more"} onClick={() => void load(query, page.nextCursor!)}>
          {status === "more" ? t("saved.loading") : t("saved.more", { count: count(Math.min(PAGE_SIZE, Math.max(0, page.total - page.items.length))) })}
        </button>
      )}
      {toast}
    </section>
  );
}

/**
 * 로그아웃 저장 탭 — 이 브라우저의 저장(nmb-saved-v1)만. 카드는 공개 요약(POST /api/product-summaries)으로 그린다.
 * 소개·로그인 단추는 마이페이지 틀(MY1)이 그린다.
 */
export function SavedBrowserList({ authEnabled }: { authEnabled: boolean }) {
  const t = useTranslations("me");
  const locale = useLocale();
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const [saved] = useSavedSlugs();
  // 브라우저 목록은 오래된 것 먼저 — 최근 저장을 앞에
  const slugs = useMemo(() => [...saved].reverse(), [saved]);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [cards, setCards] = useState<ReadonlyMap<string, SavedItem | null>>(new Map());
  const [failed, setFailed] = useState(false);
  const [removed, setRemoved, holdUndo] = useUndo<SavedItem>();
  const visible = slugs.slice(0, shown);
  const missing = visible.filter((slug) => !cards.has(slug)).join(",");

  useEffect(() => {
    if (!missing) return;
    const controller = new AbortController();
    const wanted = missing.split(",");
    (async () => {
      const found = new Map<string, SavedItem | null>(wanted.map((slug) => [slug, null]));
      for (let start = 0; start < wanted.length; start += SUMMARY_CHUNK) {
        const response = await fetch("/api/product-summaries", {
          method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ slugs: wanted.slice(start, start + SUMMARY_CHUNK), locale }),
        });
        if (!response.ok) throw new Error(String(response.status));
        for (const item of (await response.json() as { items: SavedItem[] }).items) found.set(item.slug, item);
      }
      setCards((current) => new Map([...current, ...found]));
      setFailed(false);
    })().catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [missing, locale]);

  function remove(item: SavedItem) {
    toggleSaved(item.slug, false);
    setRemoved({ item, index: 0 });
  }

  function undo() {
    if (!removed) return;
    toggleSaved(removed.item.slug, true);
    setRemoved(null);
  }

  if (!hydrated) return <section className="me-saved" aria-label={t("saved.browser.title")} />;
  const toast = <SavedTabToast removed={removed ? removed.item.name : null} onUndo={undo} onHold={holdUndo} />;
  if (slugs.length === 0) {
    return (
      <section className="me-saved" aria-labelledby="me-saved-browser">
        <h2 id="me-saved-browser" className="sr-only">{t("saved.browser.title")}</h2>
        <SavedEmpty body={t("saved.browser.emptyBody")} />
        {toast}
      </section>
    );
  }
  const items = visible.map((slug) => cards.get(slug)).filter((item): item is SavedItem => Boolean(item));
  // 내려가 카드가 없는 주소는 세지 않는다
  const gone = slugs.filter((slug) => cards.get(slug) === null).length;
  return (
    <section className="me-saved" aria-labelledby="me-saved-browser">
      <div className="me-saved-head">
        <h2 id="me-saved-browser">{t("saved.browser.title")}</h2>
        {authEnabled && <p className="me-saved-note">{t("saved.browser.note")}</p>}
      </div>
      <p className="me-saved-count">{t("saved.browser.count", { count: formatNumber(slugs.length - gone, locale) })}</p>
      {failed && <p className="me-saved-status" role="alert">{t("saved.error")}</p>}
      {items.length === 0 && missing && !failed ? <p className="me-saved-status" role="status">{t("saved.loading")}</p> : <SavedList items={items} onRemove={remove} />}
      {slugs.length > shown && (
        <button type="button" className="more-btn" onClick={() => setShown((current) => current + PAGE_SIZE)}>
          {t("saved.more", { count: formatNumber(Math.min(PAGE_SIZE, slugs.length - shown), locale) })}
        </button>
      )}
      {toast}
    </section>
  );
}
