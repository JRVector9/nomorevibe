"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { FeedbackView } from "@/lib/domain/feedback/contract";
import { FeedbackDeliveryStatus } from "./FeedbackDeliveryStatus";

export { FeedbackDeliveryStatus };

export const FEEDBACK_SUBMITTED_EVENT = "nmv:feedback-submitted";
export type FeedbackSubmittedDetail = { feedback: FeedbackView; replayed: boolean; created: boolean };

const KIND = { bug: "오류", feature: "기능 제안", question: "질문" };

export function FeedbackItem({ feedback }: { feedback: FeedbackView }) {
  return (
    <article className="rounded-xl border border-line p-4">
      <p className="text-[13px] text-fg-2">{KIND[feedback.kind]} · {feedback.authorDisplayName} · {new Date(feedback.createdAt).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
      <h3 className="mt-2 break-words text-[15px] font-semibold">
        <Link prefetch={false} href={`/feedback/${feedback.id}`} className="underline underline-offset-2">{feedback.title}</Link>
      </h3>
      <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-6">{feedback.body}</p>
      <p className="mt-3 text-[13px] text-fg-2">
        {feedback.reviewState === "held" ? "검토 중 · 작성자와 관리자만 볼 수 있음"
          : feedback.reviewState === "rejected" ? "공개되지 않음 · 작성자와 관리자만 볼 수 있음" : "서비스에 공개됨"}
        {" · "}<FeedbackDeliveryStatus feedback={feedback} />
      </p>
      {feedback.reviewReason && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-fg-2">검토 사유: {feedback.reviewReason}</p>}
    </article>
  );
}

function CompactFeedbackItem({ feedback }: { feedback: FeedbackView }) {
  const privateReview = feedback.reviewState !== "accepted";
  const githubDelivery = feedback.deliveryState !== "local_only" || !!feedback.githubIssueUrl;
  return (
    <article className="border-b border-line py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg-2">
        <strong className="break-words font-medium text-fg">{feedback.authorDisplayName}</strong>
        <span className="rounded bg-bg-card px-1.5 py-0.5">{KIND[feedback.kind]}</span>
        <time dateTime={feedback.createdAt}>{new Date(feedback.createdAt).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}</time>
        <Link prefetch={false} href={`/feedback/${feedback.id}`} className="ml-auto underline underline-offset-2">원문 보기</Link>
      </div>
      <details className="group mt-2">
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <span className="line-clamp-2 whitespace-pre-wrap break-words text-[14px] leading-6 group-open:hidden">{feedback.body}</span>
          <span className="mt-1 inline-block text-[13px] text-fg-2 underline underline-offset-2">
            <span className="group-open:hidden">내용 더보기</span><span className="hidden group-open:inline">접기</span>
          </span>
        </summary>
        <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-6">{feedback.body}</p>
      </details>
      {(privateReview || githubDelivery) && <p className="mt-2 text-[13px] leading-5 text-fg-2">
        {privateReview && <>{feedback.reviewState === "held" ? "검토 중 · 작성자와 관리자만 볼 수 있음" : "공개되지 않음 · 작성자와 관리자만 볼 수 있음"}{githubDelivery && " · "}</>}
        {githubDelivery && <FeedbackDeliveryStatus feedback={feedback} compact />}
      </p>}
      {feedback.reviewReason && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-fg-2">검토 사유: {feedback.reviewReason}</p>}
    </article>
  );
}

export function FeedbackList({ slug, children, settings }: { slug: string; children?: ReactNode; settings?: ReactNode }) {
  const [publicFeedback, setPublicFeedback] = useState<FeedbackView[]>([]);
  const [publicTotal, setPublicTotal] = useState<number | null>(null);
  const [mine, setMine] = useState<FeedbackView[] | null>(null);
  const [view, setView] = useState<"public" | "mine">("public");
  const [showAll, setShowAll] = useState(false);
  const [publicLoaded, setPublicLoaded] = useState(false);
  const [mineLoaded, setMineLoaded] = useState(false);
  const [publicError, setPublicError] = useState<string | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
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
        setPublicError(receiptIds.current.size ? "접수 결과는 보관되어 있습니다. 공개 댓글 목록을 갱신하지 못했습니다. 다시 시도해 주세요." : "공개 댓글을 불러오지 못했습니다. 다시 시도해 주세요.");
      }).finally(() => { if (current()) setPublicLoaded(true); }),
      fetch(`/api/me/feedback?slug=${encodeURIComponent(slug)}`, { cache: "no-store", signal }).then(async (response) => {
        if (response.status === 401) {
          if (!current()) return;
          mineAuthor.current = null;
          setMine(null);
          setMineError(null);
          setView("public");
          return;
        }
        if (!response.ok) throw new Error("feedback_unavailable");
        const data = await response.json() as { feedback: FeedbackView[] };
        if (!Array.isArray(data.feedback)) throw new Error("feedback_unavailable");
        if (!current()) return;
        mineAuthor.current = data.feedback[0]?.authorUserId ?? null;
        setMine(data.feedback);
        setMineError(null);
      }).catch(() => {
        if (current()) setMineError(receiptIds.current.size ? "접수 결과는 보관되어 있습니다. 내 댓글 목록을 갱신하지 못했습니다. 다시 시도해 주세요." : "내 댓글을 불러오지 못했습니다. 다시 시도해 주세요.");
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
        setPublicFeedback((items) => [{ ...item, reviewReason: null }, ...items.filter((previous) => previous.id !== item.id)].slice(0, 50));
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
      setMine((items) => [item, ...(sameAuthor ? items ?? [] : []).filter((previous) => previous.id !== item.id)].slice(0, 100));
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
        <h2 className="text-[18px] font-semibold">댓글 {publicTotal !== null && <span className="font-normal text-fg-2">{publicTotal.toLocaleString("ko-KR")}</span>}</h2>
        <div className="flex items-center gap-3 text-[13px]">
          <button type="button" aria-pressed={view === "public"} onClick={() => { setView("public"); setShowAll(false); }} className={`min-h-11 ${view === "public" ? "font-semibold text-fg" : "text-fg-2"}`}>전체</button>
          {(mine !== null || mineError) && <button type="button" aria-pressed={view === "mine"} onClick={() => { setView("mine"); setShowAll(false); }} className={`min-h-11 ${view === "mine" ? "font-semibold text-fg" : "text-fg-2"}`}>내 댓글</button>}
          <span className="text-[13px] text-fg-2">최신순</span>
          {settings}
        </div>
      </div>
      {children}
      {view === "mine" && publicError && <p className="text-[13px] text-fg-2">공개 댓글 개수를 확인하지 못했습니다.</p>}
      {!loaded && <p role="status" className="text-[14px] text-fg-2">댓글을 불러오는 중입니다.</p>}
      {error && <div role="alert"><p className="text-[14px]">{error}</p><button type="button" className="min-h-11 text-[14px] underline" onClick={() => { void load(); }}>다시 불러오기</button></div>}
      {loaded && !error && feedback.length === 0 && <p className="py-5 text-[14px] text-fg-2">{view === "mine" ? "아직 작성한 댓글이 없습니다." : "아직 댓글이 없습니다. 첫 의견을 남겨보세요."}</p>}
      {((view === "public" && (publicTotal !== null && publicTotal > 50 || feedback.length >= 50)) || (view === "mine" && feedback.length >= 100)) && <p className="text-[13px] text-fg-2">{view === "mine" ? "내 댓글은 최근 100개까지 표시합니다." : "공개 댓글은 최근 50개까지 표시합니다."}</p>}
      {visibleFeedback.length > 0 && <div>{visibleFeedback.map((item) => <CompactFeedbackItem key={item.id} feedback={item} />)}</div>}
      {feedback.length > 3 && <button type="button" aria-expanded={showAll} onClick={() => setShowAll(!showAll)} className="min-h-11 text-[13px] text-fg-2 underline underline-offset-2">{showAll ? "댓글 접기" : `댓글 더보기 (${feedback.length - 3}개)`}</button>}
    </div>
  );
}
