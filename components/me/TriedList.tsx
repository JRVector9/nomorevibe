"use client";

import "./tried.css";
import Link from "next/link";
import { memo, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ProductIcon } from "@/components/ProductIcon";
import { ReactionFields, type ReactionDraft } from "@/components/feedback/ReactionFields";
import { deleteReactionRequest, phoneWidth, putReactionRequest } from "@/components/feedback/reaction-api";
import {
  browserReactionsToMerge, fetchBrowserReactions, forgetReacted, mergeBrowserReactions, postponeReactionMerge, reactedSlugs, rememberReacted,
} from "@/components/feedback/reacted";
import type { ReactionListItem } from "@/lib/domain/reactions/contract";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatDate, formatNumber, formatRelativeTime } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import { ME_TAB_PATHS, REACTION_VERDICTS, type ReactionVerdict } from "@/lib/me/contract";

type Filter = "all" | ReactionVerdict;
type Pending = { item: ReactionListItem; index: number; timer: ReturnType<typeof setTimeout> };
/** 지운 뒤 되돌릴 수 있는 시간 — 이 시간이 지나야 서버에서 지운다 */
const UNDO_MS = 5_000;

async function fetchItems(url: string): Promise<ReactionListItem[]> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("reactions_unavailable");
  return ((await response.json()) as { reactions: ReactionListItem[] }).reactions;
}

/**
 * 로그아웃: 이 브라우저가 기억한 slug 마다 이 쿠키의 익명 평가만(Q4).
 * 로그인: 서버가 목록을 못 줬거나 다시 읽을 때만 계정 목록을 읽는다. null 은 그대로 둔다.
 */
async function loadItems(csrfToken: string | null, hasInitial: boolean): Promise<ReactionListItem[] | null> {
  if (csrfToken) return hasInitial ? null : fetchItems("/api/me/reactions");
  const found = await fetchBrowserReactions<ReactionListItem>(reactedSlugs());
  return found.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** 되돌린 평가를 제자리에 — 이미 목록에 있으면(다시 읽은 목록 등) 두 번 넣지 않는다 */
const restoreItem = (current: ReactionListItem[] | null, pending: Pending) => current && !current.some((entry) => entry.slug === pending.item.slug)
  ? [...current.slice(0, pending.index), pending.item, ...current.slice(pending.index)] : current;

/**
 * 써봤어요 탭(마이페이지 시안 3.2) — 제품마다 평가 하나, 태그, 한 줄과 그 상태, 써봄 확인, 메이커 답장.
 * 고치기는 그 자리에서 열리고 상세 판과 같은 PUT(source=me)을 쓴다. 지우기는 두 번 눌러야 하고 5초 동안 되돌릴 수 있다.
 * 로그인했고 이 브라우저에 계정으로 옮기지 않은 익명 평가가 있으면 옮길지 묻는다(«옮기기»·«나중에», 저장 탭의 묻기와 같은 모양) —
 * 공용 PC 에서 남이 남긴 평가가 묻지도 않고 내 계정에 붙지 않게.
 * 고치는 중의 값은 고치기 칸(TriedEditor)이 들고 줄은 memo 라, 한 글자마다 목록 전체(최대 500줄)를 다시 그리지 않는다.
 */
export function TriedList({ account, initial, authEnabled }: {
  account: { csrfToken: string; userId: number } | null; initial: ReactionListItem[] | null; authEnabled: boolean;
}) {
  const t = useTranslations("me");
  const locale = useLocale();
  const csrfToken = account?.csrfToken ?? null;
  const userId = account?.userId ?? null;
  const [items, setItems] = useState<ReactionListItem[] | null>(initial);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [merged, setMerged] = useState(0);
  const [offer, setOffer] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [mergeFailed, setMergeFailed] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Pending | null>(null);
  const pendingRemoval = useRef<Pending | null>(null);

  const hasInitial = initial !== null;
  useEffect(() => {
    let active = true;
    loadItems(csrfToken, hasInitial && attempt === 0).then((loaded) => {
      if (!active) return;
      // 되돌리기를 기다리는 평가는 다시 읽은 목록에서도 뺀다 — 서버에서는 아직 지우지 않았다
      const pending = pendingRemoval.current;
      if (loaded) setItems(pending ? loaded.filter((entry) => entry.slug !== pending.item.slug) : loaded);
      setFailed(false);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [csrfToken, hasInitial, attempt]);

  // 이 브라우저에 남은 익명 평가 — 읽기만 한다. 옮기기는 «옮기기»를 눌러야 한다
  useEffect(() => {
    if (userId === null) return;
    let active = true;
    void browserReactionsToMerge(userId).then((slugs) => { if (active) setOffer(slugs); });
    return () => { active = false; };
  }, [userId]);

  async function moveBrowserReactions() {
    if (userId === null || !csrfToken || merging) return;
    setMerging(true);
    setMergeFailed(false);
    const count = await mergeBrowserReactions(userId, csrfToken, offer);
    setMerging(false);
    // 옮기지 못했으면(fenced DB 등) 익명 평가는 그대로 — 묻기를 남겨 다시 누를 수 있다
    if (count === null) return setMergeFailed(true);
    setOffer([]);
    setMerged(count);
    // 옮긴 평가가 계정 목록에 들어오도록 다시 읽는다
    setAttempt((value) => value + 1);
  }

  function postponeBrowserReactions() {
    if (userId === null) return;
    postponeReactionMerge(userId);
    setOffer([]);
  }

  // 되돌리기를 기다리는 중에 떠나면 바로 지운다(keepalive). 이 브라우저 목록에는 익명 평가만 있다
  useEffect(() => {
    const flush = () => {
      const pending = pendingRemoval.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRemoval.current = null;
      if (!csrfToken) forgetReacted(pending.item.slug);
      void deleteReactionRequest(pending.item.slug, csrfToken, { keepalive: true });
    };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [csrfToken]);

  const edit = useCallback((slug: string) => {
    setEditorError(null);
    setEditing(slug);
  }, []);

  async function save(item: ReactionListItem, draft: ReactionDraft, website: string) {
    if (busy) return;
    setBusy(true);
    const result = await putReactionRequest(item.slug, {
      verdict: draft.verdict, tags: draft.tags, comment: draft.comment.trim() || null, source: "me",
      device: phoneWidth() ? "phone" : "desktop", locale, website,
    }, csrfToken);
    setBusy(false);
    if (!result.ok) {
      setEditorError(t(result.errorKey));
      setMessage(t(result.errorKey));
      return;
    }
    if (!result.signedIn) rememberReacted(item.slug);
    // 한 줄이 바뀌거나 지워지면 서버가 그 한 줄에 단 메이커 답장을 지웠다 — 화면에서도 뺀다
    setItems((current) => current?.map((entry) => entry.slug === item.slug
      ? { ...entry, ...result.mine, reply: result.mine.comment === entry.comment ? entry.reply : null } : entry) ?? current);
    setEditing(null);
    setMessage(t("tried.saved", { name: item.name }));
  }

  function commitRemoval(pending: Pending) {
    if (pendingRemoval.current !== pending) return;
    pendingRemoval.current = null;
    setRemoved(null);
    void deleteReactionRequest(pending.item.slug, csrfToken).then((result) => {
      if (result.ok) {
        if (!result.signedIn) forgetReacted(pending.item.slug);
        return;
      }
      // 지우지 못했으면 목록에 되돌려 둔다
      setItems((current) => restoreItem(current, pending));
      setMessage(t(result.errorKey));
    });
  }

  function remove(item: ReactionListItem) {
    // 앞서 지운 것이 있으면 기다리지 않고 지운다 — 되돌리기는 하나만
    if (pendingRemoval.current) {
      clearTimeout(pendingRemoval.current.timer);
      commitRemoval(pendingRemoval.current);
    }
    const index = items?.findIndex((entry) => entry.slug === item.slug) ?? -1;
    const pending: Pending = { item, index: Math.max(0, index), timer: setTimeout(() => commitRemoval(pending), UNDO_MS) };
    pendingRemoval.current = pending;
    setRemoved(pending);
    setItems((current) => current?.filter((entry) => entry.slug !== item.slug) ?? current);
    setEditing(null);
    setMessage(t("tried.deleted", { name: item.name }));
  }

  function undo() {
    const pending = pendingRemoval.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRemoval.current = null;
    setRemoved(null);
    setItems((current) => restoreItem(current, pending));
    setMessage(t("tried.restored", { name: pending.item.name }));
  }

  const notice = message ?? (merged > 0 ? t("tried.merged", { count: formatNumber(merged, locale) }) : null);
  const status = <p className="sr-only" role="status" aria-live="polite">{notice}</p>;
  if (failed && !items) {
    return (
      <section className="tried">
        <p className="tried-status">{t("tried.loadError")}</p>
        <button type="button" className="tried-button" onClick={() => setAttempt((value) => value + 1)}>{t("tried.retry")}</button>
      </section>
    );
  }
  if (!items) return <section className="tried" aria-busy="true"><p className="tried-status">{t("tried.loading")}</p></section>;

  const mergePrompt = offer.length > 0 && (
    <div className="tried-merge">
      <p>{t("tried.mergePrompt", { count: formatNumber(offer.length, locale) })}</p>
      {mergeFailed && <p className="tried-error" role="alert">{t("tried.mergeFailed")}</p>}
      <div className="tried-merge-actions">
        <button type="button" className="tried-save" onClick={moveBrowserReactions} aria-disabled={merging}>{t(merging ? "tried.merging" : "tried.mergeMove")}</button>
        <button type="button" className="tried-button" onClick={postponeBrowserReactions} disabled={merging}>{t("tried.mergeLater")}</button>
      </div>
    </div>
  );
  const undoBar = removed && (
    <div className="tried-undo">
      <span>{t("tried.deleted", { name: removed.item.name })}</span>
      <button type="button" className="tried-button" onClick={undo}>{t("tried.undo")}</button>
    </div>
  );
  if (items.length === 0) {
    return (
      <section className="tried">
        <h2 className="sr-only">{t("tried.title")}</h2>
        {mergePrompt}
        {merged > 0 && <p className="tried-browser">{t("tried.merged", { count: formatNumber(merged, locale) })}</p>}
        {undoBar}
        <div className="tried-empty">
          <p className="tried-empty-title">{t("tried.emptyTitle")}</p>
          <p className="tried-empty-body">{t("tried.emptyBody")}</p>
          <Link prefetch={false} href={localePath(locale, "/rising")} className="tried-cta">{t("tried.emptyCta")}</Link>
        </div>
        {status}
      </section>
    );
  }

  const counts = { all: items.length, good: 0, meh: 0, bad: 0 } satisfies Record<Filter, number>;
  for (const item of items) counts[item.verdict] += 1;
  const visible = filter === "all" ? items : items.filter((item) => item.verdict === filter);
  return (
    <section className="tried">
      <h2 className="sr-only">{t("tried.title")}</h2>
      {!account && (authEnabled ? (
        <p className="tried-browser">
          {t("tried.browserNote")}{" "}
          <Link prefetch={false} href={localePath(locale, `/login?returnTo=${encodeURIComponent(localePath(locale, ME_TAB_PATHS.tried))}`)}>{t("loginRequired.cta")}</Link>
        </p>
      ) : <p className="tried-browser">{t("tried.browserOnly")}</p>)}
      {mergePrompt}
      {merged > 0 && <p className="tried-browser">{t("tried.merged", { count: formatNumber(merged, locale) })}</p>}
      <div className="tried-filters" role="group" aria-label={t("tried.filter")}>
        {(["all", ...REACTION_VERDICTS] as const).map((value) => (
          <button key={value} type="button" className="tried-filter" aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {t(value === "all" ? "tried.all" : `verdict.${value}`)} <span className="tried-filter-count">{formatNumber(counts[value], locale)}</span>
          </button>
        ))}
      </div>
      {undoBar}
      {visible.length === 0 ? <p className="tried-status">{t("tried.none")}</p> : (
        <ul className="tried-list" data-track-list="tried">
          {visible.map((item) => (
            <TriedRow key={item.slug} item={item} onEdit={edit} editor={editing === item.slug ? (
              <TriedEditor item={item} busy={busy} error={editorError} onSave={(draft, website) => save(item, draft, website)}
                onRemove={() => remove(item)} onCancel={() => setEditing(null)} />
            ) : null} />
          ))}
        </ul>
      )}
      {status}
    </section>
  );
}

/** 목록 한 줄 — 고치는 줄(editor)만 다시 그린다 */
const TriedRow = memo(function TriedRow({ item, editor, onEdit }: { item: ReactionListItem; editor: ReactNode; onEdit: (slug: string) => void }) {
  const t = useTranslations("me");
  const locale = useLocale();
  const now = useServerNow();
  const open = editor !== null;
  return (
    <li className="tried-item">
      <div className="tried-head">
        <Link prefetch={false} href={localePath(locale, `/p/${item.slug}`)} className="tried-product">
          <ProductIcon name={item.name} ogImage={item.ogImage} size={44} category={item.category} />
          <span className="tried-name">{item.name}</span>
        </Link>
        <span className="tried-verdict" data-verdict={item.verdict}>{t(`verdict.${item.verdict}`)}</span>
        {!open && <button type="button" className="tried-button" onClick={() => onEdit(item.slug)}>{t("tried.edit")}</button>}
      </div>
      {!open && (
        <>
          {item.tags.length > 0 && <ul className="tried-tags">{item.tags.map((tag) => <li key={tag}>{t(`tag.${tag}`)}</li>)}</ul>}
          {item.comment && <p className="tried-comment">{item.comment}</p>}
          <p className="tried-meta">
            {item.comment && item.commentState && <span className="tried-state" data-state={item.commentState}>{t(`tried.state.${item.commentState}`)}</span>}
            <span>{formatDate(item.updatedAt, now, locale)}</span>
            {item.triedVerified && <span>{t("tried.verified")}</span>}
          </p>
          {item.comment && item.commentState === "held" && <p className="tried-note">{t("tried.heldNote")}</p>}
          {item.comment && item.commentState === "rejected" && <p className="tried-note">{t("tried.rejectedNote")}</p>}
        </>
      )}
      {item.reply && (
        <div className="tried-reply">
          <p className="tried-reply-by">{t("tried.reply")} · {item.reply.authorName ?? t("account.deletedName")} · {formatRelativeTime(item.reply.createdAt, now, locale)}</p>
          <p className="tried-reply-body">{item.reply.body}</p>
        </div>
      )}
      {editor}
    </li>
  );
});

/** 고치기 칸 — 고치는 중의 값(draft)과 지우기 한 번 더 확인을 여기서만 든다 */
function TriedEditor({ item, busy, error, onSave, onRemove, onCancel }: {
  item: ReactionListItem; busy: boolean; error: string | null;
  onSave: (draft: ReactionDraft, website: string) => void; onRemove: () => void; onCancel: () => void;
}) {
  const t = useTranslations("me");
  const [draft, setDraft] = useState<ReactionDraft>(() => ({ verdict: item.verdict, tags: item.tags, comment: item.comment ?? "" }));
  const [confirm, setConfirm] = useState(false);
  const trap = useRef<HTMLInputElement>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(draft, trap.current?.value ?? "");
  };
  return (
    <form className="tried-editor" aria-label={t("tried.editing", { name: item.name })} aria-busy={busy} onSubmit={submit}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } }}>
      <ReactionFields draft={draft} onChange={(next) => { setDraft(next); setConfirm(false); }} showVerdict variant="tried" trap={trap} />
      {error && <p className="tried-error" role="alert">{error}</p>}
      <div className="tried-actions">
        <button type="button" className="tried-remove" onClick={() => (confirm ? onRemove() : setConfirm(true))} aria-disabled={busy}>
          {t(confirm ? "tried.confirmDelete" : "tried.delete")}
        </button>
        <button type="button" className="tried-button" onClick={onCancel}>{t("tried.cancel")}</button>
        <button type="submit" className="tried-save" aria-disabled={busy}>{t("tried.save")}</button>
      </div>
    </form>
  );
}
