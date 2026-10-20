"use client";

import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatNumber, formatDate } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import type { DetailTextKey } from "./format";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { FeedbackView } from "@/lib/domain/feedback/contract";
import { FeedbackDeliveryStatus } from "./FeedbackDeliveryStatus";
import { loadMeState } from "@/components/me/account-store";

export { FeedbackDeliveryStatus };

export const FEEDBACK_SUBMITTED_EVENT = "nmv:feedback-submitted";
export type FeedbackSubmittedDetail = { feedback: FeedbackView; replayed: boolean; created: boolean };

function upsertReceipt(items: FeedbackView[], item: FeedbackView, limit: number): FeedbackView[] {
  return [item, ...items.filter((previous) => previous.id !== item.id)]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
    .slice(0, limit);
}



export function FeedbackItem({ feedback }: { feedback: FeedbackView }) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const now = useServerNow();
  return (
    <article className="rounded-xl border border-line p-4">
      <p className="text-[13px] text-fg-2">{t(`feedback.kind.${feedback.kind}`)} · {feedback.authorDisplayName ?? t("feedback.deletedAuthor")} · {formatDate(feedback.createdAt, now, locale)}</p>
      <h3 className="mt-2 break-words text-[15px] font-semibold">
        <Link prefetch={false} href={localePath(locale, `/feedback/${feedback.id}`)} className="underline underline-offset-2">{feedback.title}</Link>
      </h3>
      <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-6">{feedback.body}</p>
      <p className="mt-3 text-[13px] text-fg-2">
        {feedback.reviewState === "held" ? t("feedback.held")
          : feedback.reviewState === "rejected" ? t("feedback.rejected") : t("feedback.accepted")}
        {" · "}<FeedbackDeliveryStatus feedback={feedback} />
      </p>
      {feedback.reviewReason && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-fg-2">{t("feedback.reviewReason", { reason: feedback.reviewReason === "too_many_urls" || feedback.reviewReason === "repeated_body" ? t(`feedback.reason.${feedback.reviewReason}`) : feedback.reviewReason })}</p>}
    </article>
  );
}

function CompactFeedbackItem({ feedback }: { feedback: FeedbackView }) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const now = useServerNow();
  const privateReview = feedback.reviewState !== "accepted";
  const githubDelivery = feedback.deliveryState !== "local_only" || !!feedback.githubIssueUrl;
  return (
    <article className="border-b border-line py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg-2">
        <strong className="break-words font-medium text-fg">{feedback.authorDisplayName ?? t("feedback.deletedAuthor")}</strong>
        <span className="rounded bg-bg-card px-1.5 py-0.5">{t(`feedback.kind.${feedback.kind}`)}</span>
        <time dateTime={feedback.createdAt}>{formatDate(feedback.createdAt, now, locale)}</time>
        <Link prefetch={false} href={localePath(locale, `/feedback/${feedback.id}`)} className="ml-auto underline underline-offset-2">{t("action.original")}</Link>
      </div>
      <details className="group mt-2">
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <span className="line-clamp-2 whitespace-pre-wrap break-words text-[14px] leading-6 group-open:hidden">{feedback.body}</span>
          <span className="mt-1 inline-block text-[13px] text-fg-2 underline underline-offset-2">
            <span className="group-open:hidden">{t("action.expand")}</span><span className="hidden group-open:inline">{t("action.collapse")}</span>
          </span>
        </summary>
        <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-6">{feedback.body}</p>
      </details>
      {(privateReview || githubDelivery) && <p className="mt-2 text-[13px] leading-5 text-fg-2">
        {privateReview && <>{feedback.reviewState === "held" ? t("feedback.held") : t("feedback.rejected")}{githubDelivery && " · "}</>}
        {githubDelivery && <FeedbackDeliveryStatus feedback={feedback} compact />}
      </p>}
      {feedback.reviewReason && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-fg-2">{t("feedback.reviewReason", { reason: feedback.reviewReason === "too_many_urls" || feedback.reviewReason === "repeated_body" ? t(`feedback.reason.${feedback.reviewReason}`) : feedback.reviewReason })}</p>}
    </article>
  );
}

/**
 * 내 의견(보류 포함). 로그아웃이면 묻지 않고 null — 머리 메뉴가 받아 둔 로그인 상태(account-store)를 나눠 쓴다.
 * 401 을 "로그아웃" 신호로 쓰면 브라우저가 상세를 열 때마다 콘솔에 오류를 남기고 세션 조회도 한 번 더 한다.
 * 로그인 상태를 모르면(error) 예전처럼 물어 401 로 안다.
 */
export async function loadMineFeedback(slug: string, signal?: AbortSignal): Promise<FeedbackView[] | null> {
  const me = await loadMeState();
  if (me.status !== "error" && !me.account) return null;
  const response = await fetch(`/api/me/feedback?slug=${encodeURIComponent(slug)}`, { cache: "no-store", signal });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("feedback_unavailable");
  const data = await response.json() as { feedback: FeedbackView[] };
  if (!Array.isArray(data.feedback)) throw new Error("feedback_unavailable");
  return data.feedback;
}

export function FeedbackList({ slug, children, settings }: { slug: string; children?: ReactNode; settings?: ReactNode }) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const [publicFeedback, setPublicFeedback] = useState<FeedbackView[]>([]);
  const [publicTotal, setPublicTotal] = useState<number | null>(null);
  const [mine, setMine] = useState<FeedbackView[] | null>(null);
  const [view, setView] = useState<"public" | "mine">("public");
  const [showAll, setShowAll] = useState(false);
  const [publicLoaded, setPublicLoaded] = useState(false);
  const [mineLoaded, setMineLoaded] = useState(false);
  const [publicError, setPublicError] = useState<DetailTextKey | null>(null);
  const [mineError, setMineError] = useState<DetailTextKey | null>(null);
  const activeLoad = useRef<AbortController | null>(null);
  const loadVersion = useRef(0);
  const publicIds = useRef(new Set<string>());
  const receiptIds = useRef(new Set<string>());
  const mineAuthor = useRef<number | null>(null);
  const load = useCallback(async () => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    const version = ++loadVersion.current;
    const current = () => !controller.signal.aborted && version === loadVersion.current;
    const signal = controller.signal;
    await Promise.all([
      fetch(`/api/products/${encodeURIComponent(slug)}/feedback`, { cache: "no-store", signal }).then(async (response) => {
        if (!response.ok) throw new Error("feedback_unavailable");
        const data = await response.json() as { feedback: FeedbackView[]; total?: number };
        if (!Array.isArray(data.feedback) || data.total !== undefined && (!Number.isSafeInteger(data.total) || data.total < data.feedback.length)) throw new Error("feedback_unavailable");
        if (!current()) return;
        publicIds.current = new Set(data.feedback.map((item) => item.id));
        setPublicFeedback(data.feedback);
        setPublicTotal(data.total ?? null);
        setPublicError(null);
      }).catch(() => {
        if (!current()) return;
        setPublicTotal(null);
        setPublicError(receiptIds.current.size ? "feedback.refreshPublicFailed" : "feedback.loadPublicFailed");
      }).finally(() => { if (current()) setPublicLoaded(true); }),
      loadMineFeedback(slug, signal).then((feedback) => {
        if (!current()) return;
        if (!feedback) {
          mineAuthor.current = null;
          setMine(null);
          setMineError(null);
          setView("public");
          return;
        }
        mineAuthor.current = feedback[0]?.authorUserId ?? null;
        setMine(feedback);
        setMineError(null);
      }).catch(() => {
        if (current()) setMineError(receiptIds.current.size ? "feedback.refreshMineFailed" : "feedback.loadMineFailed");
      }).finally(() => { if (current()) setMineLoaded(true); }),
    ]);
  }, [slug]);

  useEffect(() => {
    void load();
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<FeedbackSubmittedDetail>).detail;
      if (!detail || detail.feedback.slug !== slug) return;
      const item = detail.feedback;
      const known = publicIds.current.has(item.id) || receiptIds.current.has(item.id);
      receiptIds.current.add(item.id);
      if (item.reviewState === "accepted") {
        publicIds.current.add(item.id);
        setPublicFeedback((items) => upsertReceipt(items, { ...item, reviewReason: null }, 50));
        if (detail.created && !detail.replayed && !known) setPublicTotal((total) => total === null ? null : total + 1);
        setPublicLoaded(true);
        setView("public");
      } else {
        publicIds.current.delete(item.id);
        setPublicFeedback((items) => items.filter((previous) => previous.id !== item.id));
        setView("mine");
      }
      const sameAuthor = mineAuthor.current === null || mineAuthor.current === item.authorUserId;
      mineAuthor.current = item.authorUserId;
      setMine((items) => upsertReceipt(sameAuthor ? items ?? [] : [], item, 100));
      setMineLoaded(true);
      setMineError(null);
      setShowAll(false);
      void load();
    };
    window.addEventListener(FEEDBACK_SUBMITTED_EVENT, refresh);
    return () => {
      activeLoad.current?.abort();
      window.removeEventListener(FEEDBACK_SUBMITTED_EVENT, refresh);
    };
  }, [load, slug]);

  const feedback = view === "mine" ? mine ?? [] : publicFeedback;
  const loaded = view === "mine" ? mineLoaded : publicLoaded;
  const error = view === "mine" ? mineError : publicError;
  const visibleFeedback = showAll ? feedback : feedback.slice(0, 3);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-[18px] font-semibold">{t("feedback.title")} {publicTotal !== null && <span className="font-normal text-fg-2">{formatNumber(publicTotal, locale)}</span>}</h2>
        <div className="flex items-center gap-3 text-[13px]">
          <button type="button" aria-pressed={view === "public"} onClick={() => { setView("public"); setShowAll(false); }} className={`min-h-11 ${view === "public" ? "font-semibold text-fg" : "text-fg-2"}`}>{t("feedback.all")}</button>
          {(mine !== null || mineError) && <button type="button" aria-pressed={view === "mine"} onClick={() => { setView("mine"); setShowAll(false); }} className={`min-h-11 ${view === "mine" ? "font-semibold text-fg" : "text-fg-2"}`}>{t("feedback.mine")}</button>}
          <span className="text-[13px] text-fg-2">{t("feedback.latest")}</span>
          {settings}
        </div>
      </div>
      {children}
      {view === "mine" && publicError && <p className="text-[13px] text-fg-2">{t("feedback.countUnavailable")}</p>}
      {!loaded && <p role="status" className="text-[14px] text-fg-2">{t("feedback.loading")}</p>}
      {error && <div role="alert"><p className="text-[14px]">{t(error)}</p><button type="button" className="min-h-11 text-[14px] underline" onClick={() => { void load(); }}>{t("feedback.retry")}</button></div>}
      {loaded && !error && feedback.length === 0 && <p className="py-5 text-[14px] text-fg-2">{view === "mine" ? t("feedback.emptyMine") : t("feedback.empty")}</p>}
      {((view === "public" && (publicTotal !== null && publicTotal > 50 || feedback.length >= 50)) || (view === "mine" && feedback.length >= 100)) && <p className="text-[13px] text-fg-2">{view === "mine" ? t("feedback.limitMine") : t("feedback.limitPublic")}</p>}
      {visibleFeedback.length > 0 && <div>{visibleFeedback.map((item) => <CompactFeedbackItem key={item.id} feedback={item} />)}</div>}
      {feedback.length > 3 && <button type="button" aria-expanded={showAll} onClick={() => setShowAll(!showAll)} className="min-h-11 text-[13px] text-fg-2 underline underline-offset-2">{showAll ? t("feedback.collapse") : t("feedback.more", { count: formatNumber(feedback.length - 3, locale) })}</button>}
    </div>
  );
}
