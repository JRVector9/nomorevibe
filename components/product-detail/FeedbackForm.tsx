"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FeedbackKind, FeedbackView } from "@/lib/domain/feedback/contract";
import { FEEDBACK_SUBMITTED_EVENT, type FeedbackSubmittedDetail } from "./FeedbackList";
import { FeedbackDeliveryStatus } from "./FeedbackDeliveryStatus";
import { FeedbackGithubOptions } from "./FeedbackGithubOptions";

type Draft = { requestId: string; kind: FeedbackKind; title: string; body: string; serviceDisclosureConsent: boolean; sendToGithub: boolean; githubDisclosureConsent: boolean };
type Session = { user: { displayName: string } | null; csrfToken: string | null };
const blank = (): Draft => ({ requestId: crypto.randomUUID(), kind: "bug", title: "", body: "", serviceDisclosureConsent: false, sendToGithub: false, githubDisclosureConsent: false });
const KINDS: { value: FeedbackKind; label: string }[] = [{ value: "question", label: "질문" }, { value: "bug", label: "오류" }, { value: "feature", label: "제안" }];
function titleFromBody(body: string): string {
  const firstLine = body.split(/\r\n|\r|\n/).find((line) => line.trim()) ?? "";
  // Moderation counts URLs in both fields; do not duplicate body links in the generated title.
  return firstLine.replace(/https?:\/\/[^\s<>]+/gi, "").replace(/\s+/g, " ").trim().slice(0, 120) || (body.trim() ? "댓글" : "");
}
const ERROR: Record<string, string> = {
  feedback_invalid: "내용·공개 동의를 확인해 주세요.", feedback_conflict: "이전 요청과 내용이 다릅니다. 내용을 수정한 뒤 다시 제출해 주세요.",
  feedback_rate_limited: "작성 한도를 넘었습니다. 잠시 후 다시 제출해 주세요.", login_required: "로그인한 뒤 다시 제출해 주세요.",
  invalid_csrf: "로그인 상태를 다시 확인해 주세요. 작성 내용은 이 브라우저에 남아 있습니다.",
  feedback_not_found: "현재 이 제품의 피드백을 접수할 수 없습니다.", feedback_disabled: "현재 피드백 접수가 중지되어 있습니다.",
};

export function FeedbackForm({ slug, githubDeliveryAvailable = false }: { slug: string; githubDeliveryAvailable?: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [sessionError, setSessionError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [reauthRequired, setReauthRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<FeedbackView | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const entry = useRef<HTMLButtonElement>(null);
  const submission = useRef<AbortController | null>(null);
  const storageKey = `nmv:feedback-draft:${slug}`;
  const intentKey = `nmv:feedback-write-intent:${slug}`;
  const retryKey = `nmv:feedback-retry:${slug}`;

  useEffect(() => {
    let initial = blank();
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as Draft | null;
      if (saved && typeof saved.title === "string" && typeof saved.body === "string" && typeof saved.requestId === "string"
        && ["bug", "feature", "question"].includes(saved.kind)) initial = { ...initial, ...saved };
      // Empty-title legacy drafts could never be accepted; valid legacy titles and IDs remain unchanged.
      if (initial.body.trim() && !initial.title.trim()) initial = { ...initial, title: titleFromBody(initial.body), requestId: crypto.randomUUID() };
    } catch { /* Storage may be unavailable; the live form remains usable. */ }
    const controller = new AbortController();
    fetch("/api/me", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("session_unavailable");
      const value = await response.json() as Session;
      if (controller.signal.aborted) return;
      const location = new URL(window.location.href);
      const returnToken = location.searchParams.get("feedbackCompose");
      let writeIntent = false;
      let retryDraft = false;
      try {
        const intent = JSON.parse(sessionStorage.getItem(intentKey) ?? "null") as { token?: string; expiresAt?: number } | null;
        writeIntent = !!returnToken && intent?.token === returnToken && typeof intent.expiresAt === "number" && intent.expiresAt > Date.now()
          && location.pathname === `/p/${encodeURIComponent(slug)}` && location.hash === "#feedback"
          && !location.searchParams.has("githubError") && !location.searchParams.has("error");
        sessionStorage.removeItem(intentKey);
        const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        retryDraft = navigation?.type === "reload" && !!initial.body.trim() && sessionStorage.getItem(retryKey) === initial.requestId;
      } catch { /* Without storage, only an explicit click opens the composer. */ }
      if (returnToken !== null) {
        location.searchParams.delete("feedbackCompose");
        window.history.replaceState(window.history.state, "", `${location.pathname}${location.search}${location.hash}`);
      }
      setDraft(initial);
      setSession(value);
      setSessionError(false);
      setPending(false);
      setReauthRequired(false);
      setExpanded(!!value.user && (writeIntent || retryDraft));
    }).catch(() => { if (!controller.signal.aborted) setSessionError(true); });
    return () => { controller.abort(); submission.current?.abort(); submission.current = null; };
  }, [storageKey, intentKey, retryKey, slug, sessionAttempt]);

  useEffect(() => {
    if (!draft) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* A failed request also keeps state in memory. */ }
  }, [draft, storageKey]);

  useEffect(() => {
    if (expanded) textarea.current?.focus({ preventScroll: true });
  }, [expanded]);

  function change(values: Partial<Draft>) {
    if (!draft || submission.current || Object.entries(values).every(([key, value]) => draft[key as keyof Draft] === value)) return;
    const next = { ...draft, ...values, ...(!githubDeliveryAvailable ? { sendToGithub: false, githubDisclosureConsent: false } : {}) };
    setDraft({ ...next, title: titleFromBody(next.body), requestId: crypto.randomUUID() });
    setSubmitted(null);
    setError(null);
    try { sessionStorage.removeItem(retryKey); } catch { /* The current composer remains open. */ }
  }

  function open() {
    if (!session || submission.current) return;
    if (session.user && !reauthRequired) {
      setExpanded(true);
      return;
    }
    login();
  }

  function login() {
    const token = crypto.randomUUID();
    let returnTo = `/p/${encodeURIComponent(slug)}#feedback`;
    try {
      if (draft) sessionStorage.setItem(storageKey, JSON.stringify(draft));
      sessionStorage.setItem(intentKey, JSON.stringify({ token, expiresAt: Date.now() + 10 * 60_000 }));
      returnTo = `/p/${encodeURIComponent(slug)}?feedbackCompose=${token}#feedback`;
    } catch { /* Login still works when storage is unavailable. */ }
    router.push(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  function cancel() {
    if (submission.current) return;
    setExpanded(false);
    try { sessionStorage.removeItem(retryKey); } catch { /* The draft is also kept in memory. */ }
    requestAnimationFrame(() => entry.current?.focus({ preventScroll: true }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !session?.user || !session.csrfToken || submission.current || reauthRequired) return;
    const controller = new AbortController();
    submission.current = controller;
    setPending(true); setError(null); setSubmitted(null);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(draft));
      sessionStorage.setItem(retryKey, draft.requestId);
    } catch { /* Reload can restore the same request whenever storage is available. */ }
    try {
      const response = await fetch(`/api/products/${encodeURIComponent(slug)}/feedback`, { method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify(draft), signal: controller.signal });
      const data = await response.json() as { feedback?: FeedbackView; error?: string; replayed?: boolean };
      if (controller.signal.aborted) return;
      if (!response.ok || !data.feedback) throw new Error(data.error ?? "feedback_unavailable");
      setSubmitted(data.feedback);
      setDraft(blank());
      setExpanded(false);
      try { sessionStorage.removeItem(retryKey); } catch { /* A successful receipt remains visible. */ }
      window.dispatchEvent(new CustomEvent<FeedbackSubmittedDetail>(FEEDBACK_SUBMITTED_EVENT, {
        detail: { feedback: data.feedback, replayed: data.replayed === true, created: response.status === 201 && data.replayed !== true },
      }));
      requestAnimationFrame(() => entry.current?.focus({ preventScroll: true }));
    } catch (error) {
      if (controller.signal.aborted) return;
      try { sessionStorage.setItem(retryKey, draft.requestId); } catch { /* The live draft remains available for retry. */ }
      if (error instanceof Error && ["login_required", "invalid_csrf"].includes(error.message)) {
        setReauthRequired(true);
        setError("로그인 상태를 다시 확인해야 합니다. 작성 내용은 보관되어 있습니다. 로그인한 뒤 같은 요청으로 다시 등록해 주세요.");
      } else setError(error instanceof Error ? ERROR[error.message] ?? "접수 결과를 확인하지 못했습니다. 작성 내용은 보관되어 있습니다. 다시 제출하면 같은 요청으로 확인합니다." : "접수하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      if (!controller.signal.aborted) { submission.current = null; setPending(false); }
    }
  }

  return (
    <div>
      {!expanded && <button ref={entry} type="button" onClick={open} disabled={!session} aria-label="댓글 남기기" aria-expanded={expanded} aria-controls="feedback-composer"
        className="flex min-h-12 w-full items-center gap-3 rounded-lg border border-line bg-bg-soft px-3 py-2 text-left text-[13px] text-fg-2 disabled:opacity-60">
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-card text-[13px] text-fg">{session?.user ? session.user.displayName.slice(0, 1) : "+"}</span>
        <span>댓글 남기기…</span><span className="ml-auto text-[13px] text-fg">{session?.user ? "작성" : "로그인 후 작성"}</span>
      </button>}
      {!session && !sessionError && <p role="status" className="mt-2 text-[13px] text-fg-2">로그인 상태를 확인하는 중입니다.</p>}
      {sessionError && <p role="alert" className="mt-2 text-[13px] leading-6">로그인 상태를 불러오지 못했습니다. <button type="button" onClick={() => { setSessionError(false); setSessionAttempt((attempt) => attempt + 1); }} className="min-h-11 underline underline-offset-2">다시 확인</button></p>}
      {expanded && session?.user && draft && <form id="feedback-composer" onSubmit={submit} aria-busy={pending} className="rounded-lg border border-line p-3">
        <p className="mb-3 text-[13px] font-medium">{session.user.displayName}<span className="ml-2 font-normal text-fg-2">댓글 작성</span></p>
        <fieldset disabled={pending} className="space-y-3">
          <label className="sr-only" htmlFor="feedback-body">댓글 내용</label>
          <textarea ref={textarea} id="feedback-body" className="min-h-28 w-full resize-y rounded-md bg-bg-card p-1 text-[14px] leading-6 text-fg outline-offset-2" required maxLength={5000} value={draft.body} placeholder="사용해 본 의견이나 궁금한 점을 남겨주세요." onChange={(event) => change({ body: event.target.value })} />
          <div className="flex flex-wrap items-center gap-1 border-b border-line pb-3">
            <div role="group" aria-label="댓글 종류" className="flex gap-1">{KINDS.map((kind) => <button key={kind.value} type="button" aria-pressed={draft.kind === kind.value} onClick={() => change({ kind: kind.value })}
              className={`min-h-11 rounded-md px-3 text-[13px] ${draft.kind === kind.value ? "bg-accent-soft text-accent" : "text-fg-2"}`}>{kind.label}</button>)}</div>
            <span className="ml-auto text-[13px] text-fg-2">{draft.body.length.toLocaleString("ko-KR")} / 5,000</span>
          </div>
          <label className="flex min-h-11 items-start gap-2 py-2 text-[13px] leading-6"><input className="mt-1.5 shrink-0" type="checkbox" required checked={draft.serviceDisclosureConsent} onChange={(event) => change({ serviceDisclosureConsent: event.target.checked })} />닉네임·제목·내용을 NoMoreVibe에 공개하는 데 동의합니다.</label>
          {githubDeliveryAvailable && <FeedbackGithubOptions selected={draft.sendToGithub} consent={draft.githubDisclosureConsent} onChange={change} disabled={pending} />}
          {!githubDeliveryAvailable && draft.sendToGithub && <p className="text-[13px] leading-5 text-fg-2">
            저장한 초안의 GitHub 전달을 현재 사용할 수 없습니다. <button type="button" onClick={() => change({ sendToGithub: false, githubDisclosureConsent: false })} className="min-h-11 underline underline-offset-2">GitHub 전달 선택 해제</button>
          </p>}
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-[13px] text-fg-2">이메일과 인증 정보는 적지 마세요.</p>
            <button type="button" onClick={cancel} className="min-h-11 px-3 text-[13px] text-fg-2">취소</button>
            <button type="submit" disabled={reauthRequired || !draft.body.trim() || !draft.title.trim() || !draft.serviceDisclosureConsent || (draft.sendToGithub && !draft.githubDisclosureConsent)} className="min-h-11 rounded-lg bg-accent-solid px-4 text-[13px] font-medium text-white disabled:opacity-50">{pending ? "접수 중…" : "등록"}</button>
          </div>
        </fieldset>
      </form>}
      {error && <p role="alert" className="mt-3 text-[14px] leading-6">{error}</p>}
      {reauthRequired && <button type="button" onClick={login} className="min-h-11 text-[14px] underline underline-offset-2">로그인하고 다시 등록</button>}
      {submitted && <p role="status" className="mt-3 text-[14px] leading-6">{submitted.reviewState === "accepted" ? "접수되어 서비스에 공개되었습니다."
        : submitted.reviewState === "held" ? "검토 중입니다. 검토가 끝나기 전에는 작성자와 관리자만 볼 수 있습니다."
          : "공개되지 않음. 작성자와 관리자만 볼 수 있습니다."} <FeedbackDeliveryStatus feedback={submitted} compact /> {submitted.deliveryState === "local_only" && "GitHub에는 전송되지 않았습니다."} <Link prefetch={false} className="underline underline-offset-2" href={`/feedback/${submitted.id}`}>접수 원문 보기</Link></p>}
    </div>
  );
}
