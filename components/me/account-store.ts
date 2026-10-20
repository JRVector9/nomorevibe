"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { MeSummary } from "@/lib/me/summary";

/**
 * 이 화면의 로그인 상태 — 머리 메뉴·팔로 단추·종·아래 탭 점·저장 동기화가 /api/me/summary 를 한 번만 묻게 나눠 쓴다.
 * 로그인·로그아웃은 새 문서로 열려 다시 묻는다.
 */
export type MeAccount = Pick<MeSummary, "user" | "isMaker" | "providers"> & { counts: MeSummary["counts"] | null; csrfToken: string };
/** ok = 답을 받음(로그아웃이면 account null), off = 로그인 기능이 꺼짐(404), error = 묻지 못함 */
export type MeState = { status: "ok" | "off" | "error"; account: MeAccount | null };

let state: Promise<MeState> | null = null;

export function loadMeState(): Promise<MeState> {
  state ??= fetch("/api/me/summary", { cache: "no-store" }).then(async (response): Promise<MeState> => {
    if (response.status === 404) return { status: "off", account: null };
    if (!response.ok) return { status: "error", account: null };
    const body = await response.json();
    const account = body?.user && typeof body.csrfToken === "string" ? body as MeAccount : null;
    // 첫 숫자는 요약에 들어 있다 — 종이 따로 묻지 않는다
    if (account && typeof account.counts?.unreadAlerts === "number" && unread === null) setUnreadCount(account.counts.unreadAlerts);
    return { status: "ok", account };
  }).catch((): MeState => ({ status: "error", account: null }));
  return state;
}

export function loadMeAccount(): Promise<MeAccount | null> {
  return loadMeState().then((loaded) => loaded.account);
}

/** 아직 모르면 undefined, 로그아웃이면 null */
export function useMeAccount(): MeAccount | null | undefined {
  const [value, setValue] = useState<MeAccount | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadMeAccount().then((loaded) => { if (live) setValue(loaded); });
    return () => { live = false; };
  }, []);
  return value;
}

/** 안 읽은 알림 수 — 종과 아래 탭 '마이' 점이 같은 숫자를 본다. 1분 넘게 지난 뒤 화면으로 돌아오면 다시 묻는다 */
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

async function refreshUnread() {
  if (unreadLoading) return;
  unreadLoading = true;
  try {
    const me = await loadMeAccount();
    if (!me) return setUnreadCount(0);
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

/** 로그아웃이거나 아직 모르면 0. MobileNav 의 '마이' 점도 이것을 쓴다 */
export function useUnreadCount(): number {
  const value = useSyncExternalStore(subscribe, () => unread, () => null);
  useEffect(() => {
    if (unread === null || Date.now() - unreadAt > STALE_MS) void refreshUnread();
    function onVisible() {
      if (document.visibilityState === "visible" && Date.now() - unreadAt > STALE_MS) void refreshUnread();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return value ?? 0;
}
