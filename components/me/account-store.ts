"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { MeSummary } from "@/lib/me/summary";

/**
 * 이 화면의 로그인 상태 — 머리 메뉴·팔로 단추·종·아래 탭 점·저장 동기화가 /api/me/summary 를 한 번만 묻게 나눠 쓴다.
 * 로그인·로그아웃은 새 문서로 열려 다시 묻는다. 묻지 못한 답(503·끊김)은 기억하지 않는다 — 다음 물음·화면 복귀가 다시 묻는다.
 */
export type MeAccount = Pick<MeSummary, "user" | "isMaker" | "providers"> & { counts: MeSummary["counts"] | null; csrfToken: string };
/** ok = 답을 받음(로그아웃이면 account null), off = 로그인 기능이 꺼짐(404), error = 묻지 못함 */
export type MeState = { status: "ok" | "off" | "error"; account: MeAccount | null };

let state: Promise<MeState> | null = null;
/** 받은 답 — 아직 모르면 undefined. 구독한 부품(머리 메뉴·종·팔로 단추)이 따라 그린다 */
let current: MeState | undefined;
const meListeners = new Set<() => void>();

function settle(next: MeState) {
  current = next;
  for (const listener of meListeners) listener();
}

export function loadMeState(): Promise<MeState> {
  state ??= fetch("/api/me/summary", { cache: "no-store" }).then(async (response): Promise<MeState> => {
    if (response.status === 404) return { status: "off", account: null };
    if (!response.ok) return { status: "error", account: null };
    const body = await response.json();
    const account = body?.user && typeof body.csrfToken === "string" ? body as MeAccount : null;
    // 첫 숫자는 요약에 들어 있다 — 종이 따로 묻지 않는다
    if (account && typeof account.counts?.unreadAlerts === "number" && unread === null) setUnreadCount(account.counts.unreadAlerts);
    return { status: "ok", account };
  }).catch((): MeState => ({ status: "error", account: null })).then((loaded) => {
    // 묻지 못했으면 로그아웃으로 굳히지 않는다 — 다음 loadMeState 가 다시 묻는다
    if (loaded.status === "error") state = null;
    settle(loaded);
    return loaded;
  });
  return state;
}

/** 로그아웃이거나 묻지 못했으면 null — 둘을 가려야 하는 곳(팔로 단추)은 loadMeState 를 본다 */
export function loadMeAccount(): Promise<MeAccount | null> {
  return loadMeState().then((loaded) => loaded.account);
}

/**
 * 로그인 기능이 꺼진 화면(PUBLIC_USER_AUTH_ENABLED 끔) — 머리·아래 탭이 그리면서 알린다. 요약을 묻지 않고 off 로 둔다
 * (저장 동기화·종·아래 탭 점이 404 를 묻지 않게). 그리는 중이라 구독자에게 알리지 않는다
 */
export function markAuthDisabled(): void {
  if (typeof window === "undefined" || state) return;
  const off: MeState = { status: "off", account: null };
  state = Promise.resolve(off);
  current = off;
}

/** 이 화면에서 바꾼 계정 값(닉네임) — 다시 묻지 않고 머리 메뉴에 바로 그린다 */
export function patchMeAccount(patch: { user: Partial<MeAccount["user"]> }): void {
  if (current?.status !== "ok" || !current.account) return;
  const next: MeState = { status: "ok", account: { ...current.account, user: { ...current.account.user, ...patch.user } } };
  state = Promise.resolve(next);
  settle(next);
}

function subscribeMe(listener: () => void) {
  meListeners.add(listener);
  return () => { meListeners.delete(listener); };
}

/** 아직 모르면 undefined. 묻지 못했으면 화면으로 돌아오거나 다시 이어질 때 다시 묻는다 */
export function useMeState(): MeState | undefined {
  const value = useSyncExternalStore(subscribeMe, () => current, () => undefined);
  useEffect(() => {
    void loadMeState();
    function retry() {
      if (current?.status === "error" && document.visibilityState === "visible") void loadMeState();
    }
    document.addEventListener("visibilitychange", retry);
    window.addEventListener("online", retry);
    return () => {
      document.removeEventListener("visibilitychange", retry);
      window.removeEventListener("online", retry);
    };
  }, []);
  return value;
}

/** 아직 모르거나 묻지 못했으면 undefined, 로그아웃(또는 로그인 꺼짐)이면 null */
export function useMeAccount(): MeAccount | null | undefined {
  const value = useMeState();
  return value === undefined || value.status === "error" ? undefined : value.account;
}

/** 안 읽은 알림 수 — 종·아바타 메뉴·마이페이지 탭·아래 탭 '마이' 점이 같은 숫자를 본다. 1분 넘게 지난 뒤 화면으로 돌아오면 다시 묻는다 */
const STALE_MS = 60_000;
let unread: number | null = null;
let unreadAt = 0;
let unreadLoading = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function setUnreadCount(value: number) {
  unread = Math.max(0, value);
  unreadAt = Date.now();
  emit();
}

/** 서버가 그린 숫자(마이페이지 틀) — 이 화면이 아직 숫자를 모를 때만 쓴다. 뒤로 가기로 돌아온 옛 숫자가 새 숫자를 덮지 않게 */
export function seedUnreadCount(value: number) {
  if (unread === null) setUnreadCount(value);
}

export async function refreshUnreadCount() {
  if (unreadLoading) return;
  unreadLoading = true;
  try {
    const loaded = await loadMeState();
    if (loaded.status === "error") return;
    if (!loaded.account) return setUnreadCount(0);
    // 방금 요약(또는 다른 부품)이 숫자를 채웠으면 다시 묻지 않는다
    if (unread !== null && Date.now() - unreadAt <= STALE_MS) return;
    const response = await fetch("/api/me/notifications/unread", { cache: "no-store" });
    if (response.ok) setUnreadCount(Number((await response.json()).unread) || 0);
  } catch {
    // 숫자는 덧붙이는 표시다 — 못 읽으면 다음에 다시
  } finally {
    unreadLoading = false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 로그아웃이거나 아직 모르면 fallback(기본 0). MobileNav 의 '마이' 점도 이것을 쓴다 */
export function useUnreadCount(fallback = 0): number {
  const value = useSyncExternalStore(subscribe, () => unread, () => null);
  useEffect(() => {
    if (unread === null || Date.now() - unreadAt > STALE_MS) void refreshUnreadCount();
    function onVisible() {
      if (document.visibilityState === "visible" && Date.now() - unreadAt > STALE_MS) void refreshUnreadCount();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return value ?? fallback;
}
