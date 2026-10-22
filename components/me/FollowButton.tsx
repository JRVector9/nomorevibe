"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n/context";
import { localePath, safePublicReturnUrl } from "@/lib/i18n/routing";
import type { FollowTarget } from "@/lib/me/contract";
import { loadMeState, useMeAccount } from "./account-store";
import type { FollowLabels } from "./follow-labels";
import { trackEvents } from "@/lib/analytics/client";
import type { AnalyticsEvent } from "@/lib/analytics/events";

export type FollowVariant = "hero" | "inline" | "chip" | "row";

const VARIANTS: Record<FollowVariant, { base: string; on: string; off: string }> = {
  // 상세 머리 단추 줄 — ProductHero 의 다른 단추와 같은 높이·모양
  hero: { base: "inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-[14px] font-medium sm:px-5 sm:text-[15px]",
    on: "bg-accent-soft text-accent-ink", off: "bg-bg-soft text-fg" },
  // 메타 줄의 GitHub 주인 옆 — 줄 높이는 그대로 두고 누르는 자리만 40px
  inline: { base: "-my-2.5 inline-flex min-h-10 items-center rounded-full px-2.5 text-[13px] font-semibold hover:bg-bg-soft",
    on: "text-fg-2", off: "text-accent-ink" },
  chip: { base: "inline-flex min-h-10 shrink-0 items-center rounded-full px-3.5 text-[13px] font-medium",
    on: "bg-fg text-bg-card", off: "bg-bg-soft text-fg" },
  row: { base: "inline-flex min-h-10 shrink-0 items-center rounded-full border px-3.5 text-[13px]",
    on: "border-line bg-bg-card text-fg", off: "border-transparent bg-fg text-bg-card" },
};

/** 로그인하러 간 사이 하려던 팔로 — 돌아와 같은 단추가 보이면 이어서 한다(로그인 설계 E14, 10분) */
const INTENT_KEY = "nmv-follow-intent";
const INTENT_MS = 10 * 60_000;

function readIntent(target: FollowTarget, targetKey: string): boolean {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    if (!raw) return false;
    const intent = JSON.parse(raw) as { target?: string; key?: string; at?: number };
    if (intent.target !== target || intent.key !== targetKey) return false;
    sessionStorage.removeItem(INTENT_KEY);
    return typeof intent.at === "number" && Date.now() - intent.at < INTENT_MS;
  } catch {
    return false;
  }
}

function writeIntent(target: FollowTarget, targetKey: string) {
  try { sessionStorage.setItem(INTENT_KEY, JSON.stringify({ target, key: targetKey, at: Date.now() })); } catch { /* 이어 주기는 덧붙이는 일이다 */ }
}

/**
 * 팔로가 바뀐 뒤 보낼 분석 이벤트 — 제품은 follow_change(slug), 메이커·분야는 종류만(select_content).
 * 메이커 열쇠(GitHub 아이디)는 사람을 가리키므로 보내지 않는다.
 */
export function followEvents(target: FollowTarget, targetKey: string, following: boolean, variant: FollowVariant): AnalyticsEvent[] {
  if (target === "product") {
    const surface = variant === "row" ? "me" : variant === "chip" ? "browse" : "product";
    return [{ name: "follow_change", params: { product_slug: targetKey, action: following ? "follow" : "unfollow", surface } }];
  }
  return [{ name: "select_content", params: { content_type: following ? "follow" : "unfollow", content_id: target } }];
}

/** 상세 머리 단추 둘(프로젝트·메이커)이 한 번에 묻도록 같은 틱의 물음을 모아 보낸다 — 종류마다 열쇠 하나 */
let queued: Array<{ target: FollowTarget; key: string; resolve: (value: boolean | null) => void }> = [];

async function flushStates() {
  const items = queued;
  queued = [];
  while (items.length) {
    const group: typeof items = [];
    for (let index = 0; index < items.length;) {
      if (group.some((item) => item.target === items[index].target)) index += 1;
      else group.push(...items.splice(index, 1));
    }
    const query = new URLSearchParams(group.map((item) => [item.target, item.key]));
    const body = await fetch(`/api/me/follows/state?${query}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<Partial<Record<FollowTarget, boolean>>> : null).catch(() => null);
    for (const item of group) item.resolve(body ? body[item.target] === true : null);
  }
}

function followStateOf(target: FollowTarget, key: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    queued.push({ target, key, resolve });
    if (queued.length === 1) setTimeout(() => void flushStates(), 0);
  });
}

/**
 * 팔로 단추 — 상세·분야 화면은 엣지에 저장되므로 내 상태는 붙은 뒤 따로 묻는다. 로그아웃이면 누를 때 작은 창으로 로그인을 권하고,
 * 로그인에서 돌아오면 하려던 팔로를 이어 한다. 누르면 바로 바꿔 보이고 실패하면 되돌린다.
 */
export function FollowButton({ target, targetKey, labels, variant = "hero", initial, onChange }: {
  target: FollowTarget; targetKey: string; labels: FollowLabels; variant?: FollowVariant;
  /** 이미 아는 상태(팔로 탭) — 주면 묻지 않는다 */
  initial?: boolean; onChange?: (following: boolean) => void;
}) {
  const locale = useLocale();
  const account = useMeAccount();
  const [following, setFollowing] = useState<boolean | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  /** 누른 뒤에는 늦게 온 상태 물음이 바꾼 값을 덮지 않는다(로그인 상태를 다시 물어 받은 뒤 묻는 경우) */
  const touched = useRef(false);
  const titleId = useId();

  async function change(next: boolean) {
    // 로그인 상태를 묻지 못했으면(503·끊김) 로그인을 권하지 않는다 — 실패를 말하고, 다음 누름이 다시 묻는다
    const loaded = await loadMeState();
    if (loaded.status === "error") return setError(labels.failed);
    const me = loaded.account;
    if (!me) return setPrompt(true);
    touched.current = true;
    setBusy(true);
    setError("");
    setFollowing(next);
    try {
      const response = await fetch("/api/me/follows", { method: next ? "PUT" : "DELETE",
        headers: { "content-type": "application/json", "x-csrf-token": me.csrfToken }, body: JSON.stringify({ targetType: target, targetKey }) });
      if (!response.ok) {
        const code = await response.json().then((body) => body?.error).catch(() => null);
        throw new Error(code === "follow_limit" ? labels.limit : labels.failed);
      }
      trackEvents(followEvents(target, targetKey, next, variant));
      onChange?.(next);
    } catch (failure) {
      setFollowing(!next);
      setError(failure instanceof Error && failure.message ? failure.message : labels.failed);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!account || initial !== undefined) return;
    let live = true;
    void followStateOf(target, targetKey).then((state) => {
      if (!live || touched.current) return;
      setFollowing(state);
      if (state === false && readIntent(target, targetKey)) void change(true);
    });
    return () => { live = false; };
    // change 는 같은 단추의 같은 열쇠만 쓴다 — 열쇠가 바뀔 때만 다시 묻는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, target, targetKey, initial]);

  // 로그인 권하는 작은 창 — 열리면 첫 링크에 초점, 바깥을 누르거나 초점이 나가면 닫고, Esc 는 단추로 초점을 돌려준다
  useEffect(() => {
    if (!prompt) return;
    wrapper.current?.querySelector<HTMLElement>("[role=dialog] a, [role=dialog] button")?.focus();
    function close(event: KeyboardEvent | PointerEvent) {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        setPrompt(false);
        button.current?.focus();
      } else if (!wrapper.current?.contains(event.target as Node)) setPrompt(false);
    }
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [prompt]);

  const on = following === true;
  const style = VARIANTS[variant];
  const loginHref = (returnTo: string) => localePath(locale, `/login?returnTo=${encodeURIComponent(safePublicReturnUrl(returnTo, localePath(locale, "/")))}`);
  return (
    <span ref={wrapper} className="relative inline-flex items-center" onBlur={(event) => {
      if (prompt && event.relatedTarget && !wrapper.current?.contains(event.relatedTarget as Node)) setPrompt(false);
    }}>
      <button ref={button} type="button" aria-pressed={account ? on : undefined} aria-label={labels.aria} disabled={busy}
        aria-expanded={account === null ? prompt : undefined} aria-controls={account === null && prompt ? titleId : undefined}
        onClick={() => account === null ? setPrompt((open) => !open) : void change(!on)}
        className={`${style.base} ${on ? style.on : style.off} disabled:opacity-60`}>
        {on ? labels.following : labels.follow}
      </button>
      {error && <span role="alert" className="ml-2 text-[13px] text-down">{error}</span>}
      {prompt && (
        <span role="dialog" aria-labelledby={titleId}
          className="fixed inset-x-4 bottom-4 z-40 flex flex-col gap-2 rounded-[16px] border border-line bg-bg-card p-4 text-left shadow-[0_8px_24px_rgb(0_0_0/14%)] sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:mt-2 sm:w-72">
          <strong id={titleId} className="text-[15px] font-semibold text-fg">{labels.loginTitle}</strong>
          <span className="text-[13px] leading-5 text-fg-2">{labels.loginBody}</span>
          <span className="mt-1 flex items-center gap-2">
            <a href={loginHref("/")} onClick={(event) => {
              writeIntent(target, targetKey);
              event.currentTarget.href = loginHref(`${window.location.pathname}${window.location.search}${window.location.hash}`);
            }} className="inline-flex min-h-10 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg-card">{labels.login}</a>
            <button type="button" onClick={() => { setPrompt(false); button.current?.focus(); }} className="inline-flex min-h-10 items-center rounded-full px-3 text-[13px] text-fg-2">{labels.later}</button>
          </span>
        </span>
      )}
    </span>
  );
}
