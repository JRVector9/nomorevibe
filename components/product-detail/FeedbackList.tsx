"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FeedbackView } from "@/lib/domain/feedback/contract";

const KIND = { bug: "오류", feature: "기능 제안", question: "질문" };
const DELIVERY = {
  local_only: "서비스에 접수됨", queued: "GitHub 전송 대기", sending: "GitHub 전송 확인 중", delivered: "GitHub에 전송됨",
  retry_wait: "GitHub 전송 재시도 대기", uncertain: "GitHub 전송 결과 확인 중", blocked: "GitHub 전송 중지", cancelled: "GitHub 전송 취소",
};

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
        {" · "}{DELIVERY[feedback.deliveryState]}
      </p>
      {feedback.reviewReason && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-fg-2">검토 사유: {feedback.reviewReason}</p>}
    </article>
  );
}

export function FeedbackList({ slug }: { slug: string }) {
  const [publicFeedback, setPublicFeedback] = useState<FeedbackView[]>([]);
  const [mine, setMine] = useState<FeedbackView[] | null>(null);
  const [view, setView] = useState<"public" | "mine">("public");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [response, personal] = await Promise.all([
        fetch(`/api/products/${encodeURIComponent(slug)}/feedback`, { cache: "no-store", signal }),
        fetch(`/api/me/feedback?slug=${encodeURIComponent(slug)}`, { cache: "no-store", signal }),
      ]);
      if (!response.ok) throw new Error("feedback_unavailable");
      const publicData = await response.json() as { feedback: FeedbackView[] };
      setPublicFeedback(publicData.feedback);
      if (personal.ok) {
        const personalData = await personal.json() as { feedback: FeedbackView[] };
        setMine(personalData.feedback);
      } else if (personal.status === 401) setMine(null);
      setError(null);
      setLoaded(true);
    } catch (error) {
      if (signal?.aborted) return;
      setError(error instanceof Error ? "피드백을 불러오지 못했습니다. 다시 시도해 주세요." : "피드백 조회에 실패했습니다.");
      setLoaded(true);
    }
  }, [slug]);

  useEffect(() => {
    const controller = new AbortController();
    // Every state update in load follows the asynchronous fetch response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    const refresh = () => { void load(controller.signal); };
    window.addEventListener("nmv:feedback-submitted", refresh);
    return () => { controller.abort(); window.removeEventListener("nmv:feedback-submitted", refresh); };
  }, [load]);

  const feedback = view === "mine" ? mine ?? [] : publicFeedback;
  return (
    <section aria-label="피드백 목록" className="space-y-3">
      <div className="flex gap-2">
        <button type="button" aria-pressed={view === "public"} onClick={() => setView("public")} className="min-h-11 rounded-full border border-line px-4 text-[14px]">공개 피드백</button>
        {mine !== null && <button type="button" aria-pressed={view === "mine"} onClick={() => setView("mine")} className="min-h-11 rounded-full border border-line px-4 text-[14px]">내 피드백</button>}
      </div>
      {!loaded && <p role="status" className="text-[14px] text-fg-2">피드백을 불러오는 중입니다.</p>}
      {error && <div role="alert"><p className="text-[14px]">{error}</p><button type="button" className="min-h-11 text-[14px] underline" onClick={() => { void load(); }}>다시 불러오기</button></div>}
      {loaded && !error && feedback.length === 0 && <p className="text-[14px] text-fg-2">{view === "mine" ? "아직 작성한 피드백이 없습니다." : "아직 공개된 피드백이 없습니다."}</p>}
      {feedback.map((item) => <FeedbackItem key={item.id} feedback={item} />)}
    </section>
  );
}
