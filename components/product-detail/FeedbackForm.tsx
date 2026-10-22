"use client";

import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath, stripLocale } from "@/lib/i18n/routing";
import type { DetailTextKey } from "./format";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FeedbackKind, FeedbackView } from "@/lib/domain/feedback/contract";
import { FEEDBACK_SUBMITTED_EVENT, type FeedbackSubmittedDetail } from "./FeedbackList";
import { FeedbackDeliveryStatus } from "./FeedbackDeliveryStatus";
import { FeedbackGithubOptions } from "./FeedbackGithubOptions";
import { track } from "@/lib/analytics/client";

type Draft = { requestId: string; kind: FeedbackKind; title: string; body: string; serviceDisclosureConsent: boolean; sendToGithub: boolean; githubDisclosureConsent: boolean };
type Session = { user: { displayName: string } | null; csrfToken: string | null };
const blank = (): Draft => ({ requestId: crypto.randomUUID(), kind: "bug", title: "", body: "", serviceDisclosureConsent: false, sendToGithub: false, githubDisclosureConsent: false });
const KINDS: { value: FeedbackKind }[] = [{ value: "question" }, { value: "bug" }, { value: "feature" }];
function titleFromBody(body: string, fallbackTitle: string): string {
  const firstLine = body.split(/\r\n|\r|\n/).find((line) => line.trim()) ?? "";
  // Moderation counts URLs in both fields; do not duplicate body links in the generated title.
  return firstLine.replace(/https?:\/\/[^\s<>]+/gi, "").replace(/\s+/g, " ").trim().slice(0, 120) || (body.trim() ? fallbackTitle : "");
}
const ERROR: Record<string, DetailTextKey> = {
  feedback_invalid: "error.feedback_invalid", feedback_conflict: "error.feedback_conflict",
  feedback_rate_limited: "error.feedback_rate_limited", login_required: "error.login_required",
  invalid_csrf: "error.invalid_csrf",
  feedback_not_found: "error.feedback_not_found", feedback_disabled: "error.feedback_disabled",
};

export function FeedbackForm({ slug, githubDeliveryAvailable = false }: { slug: string; githubDeliveryAvailable?: boolean }) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const fallbackTitle = t("feedback.defaultTitle");
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [sessionError, setSessionError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [reauthRequired, setReauthRequired] = useState(false);
  const [error, setError] = useState<DetailTextKey | null>(null);
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
      if (initial.body.trim() && !initial.title.trim()) {
        // Empty-title legacy drafts could never be accepted by the existing API.
        initial = { ...initial, title: titleFromBody(initial.body, fallbackTitle), requestId: crypto.randomUUID() };
      }
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
          && stripLocale(location.pathname) === `/p/${encodeURIComponent(slug)}` && location.hash === "#feedback"
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
  }, [storageKey, intentKey, retryKey, slug, sessionAttempt, fallbackTitle]);

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
    setDraft({ ...next, title: titleFromBody(next.body, fallbackTitle), requestId: crypto.randomUUID() });
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
    const location = new URL(window.location.href);
    location.pathname = localePath(locale, `/p/${encodeURIComponent(slug)}`);
    location.hash = "#feedback";
    try {
      if (draft) sessionStorage.setItem(storageKey, JSON.stringify(draft));
      sessionStorage.setItem(intentKey, JSON.stringify({ token, expiresAt: Date.now() + 10 * 60_000 }));
      location.searchParams.set("feedbackCompose", token);
    } catch { /* Login still works when storage is unavailable. */ }
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    router.push(localePath(locale, `/login?returnTo=${encodeURIComponent(returnTo)}`));
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
      // 종류만 — 제목·본문은 보내지 않는다. 같은 요청을 다시 보낸 것(replayed)은 세지 않는다
      if (data.replayed !== true) track("feedback_submit", { product_slug: slug, feedback_kind: draft.kind });
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
        setError("error.feedbackReauth");
      } else setError(error instanceof Error ? ERROR[error.message] ?? "error.feedbackUncertain" : "error.feedbackFailed");
    } finally {
      if (!controller.signal.aborted) { submission.current = null; setPending(false); }
    }
  }

  return (
    <div>
      {!expanded && <button ref={entry} type="button" onClick={open} disabled={!session} aria-label={t("feedback.compose")} aria-expanded={expanded} aria-controls="feedback-composer"
        className="flex min-h-12 w-full items-center gap-3 rounded-lg border border-line bg-bg-soft px-3 py-2 text-left text-[13px] text-fg-2 disabled:opacity-60">
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-card text-[13px] text-fg">{session?.user ? session.user.displayName.slice(0, 1) : "+"}</span>
        <span>{t("feedback.composePlaceholder")}</span><span className="ml-auto text-[13px] text-fg">{session?.user ? t("feedback.write") : t("feedback.loginWrite")}</span>
      </button>}
      {!session && !sessionError && <p role="status" className="mt-2 text-[13px] text-fg-2">{t("feedback.checkingSession")}</p>}
      {sessionError && <p role="alert" className="mt-2 text-[13px] leading-6">{t("feedback.sessionFailed")} <button type="button" onClick={() => { setSessionError(false); setSessionAttempt((attempt) => attempt + 1); }} className="min-h-11 underline underline-offset-2">{t("action.retry")}</button></p>}
      {expanded && session?.user && draft && <form id="feedback-composer" onSubmit={submit} aria-busy={pending} className="rounded-lg border border-line p-3">
        <p className="mb-3 text-[13px] font-medium">{session.user.displayName}<span className="ml-2 font-normal text-fg-2">{t("feedback.writing")}</span></p>
        <fieldset disabled={pending} className="space-y-3">
          <label className="sr-only" htmlFor="feedback-body">{t("feedback.body")}</label>
          <textarea ref={textarea} id="feedback-body" className="min-h-28 w-full resize-y rounded-md bg-bg-card p-1 text-[14px] leading-6 text-fg outline-offset-2" required maxLength={5000} value={draft.body} placeholder={t("feedback.placeholder")} onChange={(event) => change({ body: event.target.value })} />
          <div className="flex flex-wrap items-center gap-1 border-b border-line pb-3">
            <div role="group" aria-label={t("feedback.kindLabel")} className="flex gap-1">{KINDS.map((kind) => <button key={kind.value} type="button" aria-pressed={draft.kind === kind.value} onClick={() => change({ kind: kind.value })}
              className={`min-h-11 rounded-md px-3 text-[13px] ${draft.kind === kind.value ? "bg-accent-soft text-accent" : "text-fg-2"}`}>{t(kind.value === "feature" ? "feedback.kind.featureShort" : `feedback.kind.${kind.value}`)}</button>)}</div>
            <span className="ml-auto text-[13px] text-fg-2">{formatNumber(draft.body.length, locale)} / {formatNumber(5000, locale)}</span>
          </div>
          <label className="flex min-h-11 items-start gap-2 py-2 text-[13px] leading-6"><input className="mt-1.5 shrink-0" type="checkbox" required checked={draft.serviceDisclosureConsent} onChange={(event) => change({ serviceDisclosureConsent: event.target.checked })} />{t("feedback.disclosure")}</label>
          {githubDeliveryAvailable && <FeedbackGithubOptions selected={draft.sendToGithub} consent={draft.githubDisclosureConsent} onChange={change} disabled={pending} />}
          {!githubDeliveryAvailable && draft.sendToGithub && <p className="text-[13px] leading-5 text-fg-2">
            {t("feedback.githubUnavailable")} <button type="button" onClick={() => change({ sendToGithub: false, githubDisclosureConsent: false })} className="min-h-11 underline underline-offset-2">{t("feedback.githubDeselect")}</button>
          </p>}
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-[13px] text-fg-2">{t("feedback.noSecrets")}</p>
            <button type="button" onClick={cancel} className="min-h-11 px-3 text-[13px] text-fg-2">{t("action.cancel")}</button>
            <button type="submit" disabled={reauthRequired || !draft.body.trim() || !draft.title.trim() || !draft.serviceDisclosureConsent || (draft.sendToGithub && !draft.githubDisclosureConsent)} className="min-h-11 rounded-lg bg-accent-solid px-4 text-[13px] font-medium text-white disabled:opacity-50">{pending ? t("feedback.submitting") : t("feedback.submit")}</button>
          </div>
        </fieldset>
      </form>}
      {error && <p role="alert" className="mt-3 text-[14px] leading-6">{t(error)}</p>}
      {reauthRequired && <button type="button" onClick={login} className="min-h-11 text-[14px] underline underline-offset-2">{t("feedback.loginRetry")}</button>}
      {submitted && <p role="status" className="mt-3 text-[14px] leading-6">{submitted.reviewState === "accepted" ? t("feedback.received")
        : submitted.reviewState === "held" ? t("feedback.receivedHeld")
          : t("feedback.receivedRejected")} <FeedbackDeliveryStatus feedback={submitted} compact /> {submitted.deliveryState === "local_only" && t("feedback.notSent")} <Link prefetch={false} className="underline underline-offset-2" href={localePath(locale, `/feedback/${submitted.id}`)}>{t("feedback.receipt")}</Link></p>}
    </div>
  );
}
