"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FeedbackKind, FeedbackView } from "@/lib/domain/feedback/contract";
import { FeedbackDeliveryStatus } from "./FeedbackList";

type Draft = { requestId: string; kind: FeedbackKind; title: string; body: string; serviceDisclosureConsent: boolean; sendToGithub: boolean; githubDisclosureConsent: boolean };
const blank = (): Draft => ({ requestId: crypto.randomUUID(), kind: "bug", title: "", body: "", serviceDisclosureConsent: false, sendToGithub: false, githubDisclosureConsent: false });
const FIELD = "mt-1 w-full rounded-lg border border-line bg-bg-card p-3 text-[14px] text-fg";
const ERROR: Record<string, string> = {
  feedback_invalid: "제목·내용·공개 동의를 확인해 주세요.", feedback_conflict: "이전 요청과 내용이 다릅니다. 내용을 수정한 뒤 다시 제출해 주세요.",
  feedback_rate_limited: "작성 한도를 넘었습니다. 잠시 후 다시 제출해 주세요.", login_required: "로그인한 뒤 다시 제출해 주세요.",
  invalid_csrf: "로그인 상태를 다시 확인해 주세요. 작성 내용은 이 브라우저에 남아 있습니다.",
  feedback_not_found: "현재 이 제품의 피드백을 접수할 수 없습니다.", feedback_disabled: "현재 피드백 접수가 중지되어 있습니다.",
};

export function FeedbackForm({ slug, githubDeliveryAvailable = false }: { slug: string; githubDeliveryAvailable?: boolean }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [session, setSession] = useState<{ user: { displayName: string } | null; csrfToken: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<FeedbackView | null>(null);
  const storageKey = `nmv:feedback-draft:${slug}`;

  useEffect(() => {
    let initial = blank();
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as Draft | null;
      if (saved && typeof saved.title === "string" && typeof saved.body === "string" && typeof saved.requestId === "string"
        && ["bug", "feature", "question"].includes(saved.kind)) initial = { ...initial, ...saved };
    } catch { /* Storage may be unavailable; the live form remains usable. */ }
    const controller = new AbortController();
    fetch("/api/me", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("session_unavailable");
      const value = await response.json();
      if (controller.signal.aborted) return;
      setDraft(initial);
      setSession(value);
    }).catch(() => { if (!controller.signal.aborted) setError("로그인 상태를 불러오지 못했습니다. 새로고침한 뒤 다시 시도해 주세요."); });
    return () => controller.abort();
  }, [storageKey]);

  useEffect(() => {
    if (!draft) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* A failed request also keeps state in memory. */ }
  }, [draft, storageKey]);

  function change(values: Partial<Draft>) {
    setDraft((previous) => previous ? { ...previous, ...values, requestId: crypto.randomUUID() } : previous);
    setSubmitted(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !session?.user || !session.csrfToken || pending) return;
    setPending(true); setError(null); setSubmitted(null);
    try {
      const response = await fetch(`/api/products/${encodeURIComponent(slug)}/feedback`, { method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify(draft) });
      const data = await response.json() as { feedback?: FeedbackView; error?: string };
      if (!response.ok || !data.feedback) throw new Error(data.error ?? "feedback_unavailable");
      setSubmitted(data.feedback);
      setDraft(blank());
      window.dispatchEvent(new Event("nmv:feedback-submitted"));
    } catch (error) {
      setError(error instanceof Error ? ERROR[error.message] ?? "접수 결과를 확인하지 못했습니다. 작성 내용은 보관되어 있습니다. 다시 제출하면 같은 요청으로 확인합니다." : "접수하지 못했습니다. 다시 시도해 주세요.");
    } finally { setPending(false); }
  }

  return (
    <section id="feedback" className="rounded-[18px] border border-line p-5">
      <h2 className="text-[18px] font-semibold">제품 피드백</h2>
      <p className="mt-2 text-[14px] leading-6 text-fg-2">오류·제안·질문을 남겨 주세요. 승인된 글은 닉네임과 함께 NoMoreVibe에 공개됩니다. 이메일과 인증 정보는 적지 마세요.</p>
      {!session && !error && <p role="status" className="mt-3 text-[14px] text-fg-2">로그인 상태를 확인하는 중입니다.</p>}
      {session && !session.user && <p className="mt-3 text-[14px]">피드백을 작성하려면 <Link prefetch={false} href={`/login?returnTo=${encodeURIComponent(`/p/${slug}#feedback`)}`} className="underline underline-offset-2">이메일 로그인</Link>해 주세요. GitHub 계정 연결은 필요하지 않습니다.</p>}
      {session?.user && draft && <form onSubmit={submit} className="mt-4 space-y-4">
        <p className="text-[13px] text-fg-2">작성자: {session.user.displayName}</p>
        <fieldset disabled={pending} className="space-y-4">
          <label className="block text-[14px]">종류<select className={FIELD} value={draft.kind} onChange={(event) => change({ kind: event.target.value as FeedbackKind })}>
            <option value="bug">오류</option><option value="feature">기능 제안</option><option value="question">질문</option>
          </select></label>
          <label className="block text-[14px]">피드백 제목<input className={FIELD} required maxLength={120} value={draft.title} onChange={(event) => change({ title: event.target.value })} /></label>
          <label className="block text-[14px]">피드백 내용<textarea className={`${FIELD} min-h-36`} required maxLength={5000} value={draft.body} onChange={(event) => change({ body: event.target.value })} /></label>
          <label className="flex min-h-11 items-center gap-3 text-[14px]"><input type="checkbox" required checked={draft.serviceDisclosureConsent} onChange={(event) => change({ serviceDisclosureConsent: event.target.checked })} />닉네임·제목·내용을 NoMoreVibe에 공개하는 데 동의합니다.</label>
          {githubDeliveryAvailable ? <>
            <label className="flex min-h-11 items-center gap-3 text-[14px]"><input type="checkbox" checked={draft.sendToGithub} onChange={(event) => change({ sendToGithub: event.target.checked, githubDisclosureConsent: false })} />제작자가 연결한 GitHub 저장소에 이슈로 전송합니다.</label>
            {draft.sendToGithub && <label className="flex min-h-11 items-center gap-3 text-[14px]"><input type="checkbox" required checked={draft.githubDisclosureConsent} onChange={(event) => change({ githubDisclosureConsent: event.target.checked })} />닉네임·원문 링크·내용이 앱 봇의 GitHub 공개 이슈에 게시되는 데 별도로 동의합니다.</label>}
          </> : <p className="text-[13px] leading-5 text-fg-2">이 제품의 GitHub 전송은 아직 사용할 수 없습니다. 피드백은 서비스에서 접수합니다.</p>}
          <button type="submit" className="min-h-11 rounded-full bg-accent-solid px-5 text-[14px] font-medium text-white">{pending ? "접수 중…" : "피드백 제출"}</button>
        </fieldset>
      </form>}
      {error && <p role="alert" className="mt-3 text-[14px] leading-6">{error}</p>}
      {submitted && <p role="status" className="mt-3 text-[14px] leading-6">{submitted.reviewState === "held" ? "접수되었습니다. 검토가 끝나기 전에는 작성자와 관리자만 볼 수 있습니다." : "접수되어 서비스에 공개되었습니다."} <FeedbackDeliveryStatus feedback={submitted} /> {submitted.deliveryState === "local_only" && "GitHub에는 전송되지 않았습니다."} <Link prefetch={false} className="underline underline-offset-2" href={`/feedback/${submitted.id}`}>접수 원문 보기</Link></p>}
    </section>
  );
}
