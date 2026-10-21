"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { MeHeader } from "@/lib/me/summary";

/**
 * 이 화면의 로그인 상태 — 머리 메뉴·팔로 단추·종·아래 탭 점·저장 동기화·상세 내 의견이 GET /api/me?view=header 를 한 번만 묻게 나눠 쓴다.
 * 로그인·로그아웃은 새 문서로 열려 다시 묻는다. 로그인 답·꺼짐은 이 화면 동안 그대로 쓴다.
 * 묻지 못한 답(503·끊김)은 다음 물음이 다시 묻는다. 로그아웃 답은 다른 탭에서 로그인했을 수 있어 화면으로 돌아오거나 1분이 지나면 다시 묻는다.
 */
export type MeAccount = { user: { id: number; displayName: string }; csrfToken: string } & Pick<MeHeader, "isMaker" | "providers"> & {
  /** 저장 판 — 지난번과 같으면 저장 동기화가 계정 목록을 다시 받지 않는다. 옛 서버(view 를 모름)는 주지 않는다 */
  savedVersion: string | null;
};
/** ok = 답을 받음(로그아웃이면 account null), off = 로그인 기능이 꺼짐(404 public_auth_disabled), error = 묻지 못함 */
export type MeState = { status: "ok" | "off" | "error"; account: MeAccount | null };

const ME_URL = "/api/me?view=header";
/** 로그아웃 답을 다시 쓰는 동안 — 지나면 다음 물음이 다시 묻는다. 화면 복귀는 RECHECK_MS 만 지나도 묻는다 */
const LOGGED_OUT_MS = 60_000;
const RECHECK_MS = 5_000;

let state: Promise<MeState> | null = null;
/** 받은 답 — 아직 모르면 undefined. 구독한 부품(머리 메뉴·종·팔로 단추·저장 동기화)이 따라 그린다 */
let current: MeState | undefined;
let asking = false;
let answeredAt = 0;
let watching = false;
const meListeners = new Set<() => void>();

function settle(next: MeState) {
  // 다시 물어 같은 로그아웃·실패 답이 오면 그리지 않는다
  if (current && !current.account && !next.account && current.status === next.status) return;
  current = next;
  for (const listener of meListeners) listener();
}

/** 응답 → 상태. 로그인 기능이 꺼진 404 만 off — 다른 404(배포 중 아직 이 주소를 모르는 서버의 HTML 404 등)는 묻지 못한 것으로 둔다 */
async function readMe(response: Response): Promise<MeState> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (response.status === 404 && body?.error === "public_auth_disabled") return { status: "off", account: null };
  if (!response.ok || !body) return { status: "error", account: null };
  const user = body.user as { id?: unknown; displayName?: unknown } | null | undefined;
  if (!user || typeof user.id !== "number" || typeof body.csrfToken !== "string") return { status: "ok", account: null };
  // 첫 숫자는 이 답에 들어 있다 — 종이 따로 묻지 않는다(로그아웃 답의 0 은 덮는다). 옛 서버는 user·csrfToken 만 준다(수단·메이커는 빈 값, 숫자는 종이 묻는다)
  if (typeof body.unreadAlerts === "number" && (unread === null || !current?.account)) setUnreadCount(body.unreadAlerts);
  return { status: "ok", account: {
    user: { id: user.id, displayName: typeof user.displayName === "string" ? user.displayName : "" },
    csrfToken: body.csrfToken,
    isMaker: body.isMaker === true,
    providers: Array.isArray(body.providers) ? body.providers as MeAccount["providers"] : [],
    savedVersion: typeof body.savedVersion === "string" && body.savedVersion ? body.savedVersion : null,
  } };
}

function ask(): Promise<MeState> {
  asking = true;
  watch();
  state = fetch(ME_URL, { cache: "no-store" }).then(readMe).catch((): MeState => ({ status: "error", account: null })).then((loaded) => {
    asking = false;
    answeredAt = Date.now();
    settle(loaded);
    return loaded;
  });
  return state;
}

/** 다시 물을 답인가 — 묻지 못했거나, 로그아웃 답이 maxAge 보다 오래됐다. 묻는 중·꺼짐·로그인 답은 그대로 쓴다 */
function stale(maxAge: number): boolean {
  if (asking || !current) return false;
  return current.status === "error" || (current.status === "ok" && !current.account && Date.now() - answeredAt >= maxAge);
}

/** 화면으로 돌아오면(다른 탭에서 로그인했을 수 있다)·다시 이어지면 다시 묻는다 — 부품마다가 아니라 화면에 하나 */
function watch() {
  if (watching || typeof document === "undefined" || typeof window === "undefined") return;
  watching = true;
  const again = () => { if (document.visibilityState === "visible" && stale(RECHECK_MS)) void ask(); };
  document.addEventListener("visibilitychange", again);
  window.addEventListener("focus", again);
  window.addEventListener("online", again);
}

export function loadMeState(): Promise<MeState> {
  return !state || stale(LOGGED_OUT_MS) ? ask() : state;
}

/** 로그인했을 것 같은 때(의견을 올림·서버가 로그인으로 그린 화면) — 로그아웃·실패 답을 바로 다시 묻는다 */
export function recheckMeState(): Promise<MeState> {
  return !state || stale(0) ? ask() : state;
}

/** 로그아웃이거나 묻지 못했으면 null — 둘을 가려야 하는 곳(팔로 단추)은 loadMeState 를 본다 */
export function loadMeAccount(): Promise<MeAccount | null> {
  return loadMeState().then((loaded) => loaded.account);
}

/**
 * 로그인 기능이 꺼진 화면(PUBLIC_USER_AUTH_ENABLED 끔) — 머리·아래 탭이 그리면서 알린다. 묻지 않고 off 로 둔다
 * (저장 동기화·종·아래 탭 점이 404 를 묻지 않게). 그리는 중이라 구독자에게 알리지 않는다
 */
export function markAuthDisabled(): void {
  if (typeof window === "undefined" || state) return;
  const off: MeState = { status: "off", account: null };
  state = Promise.resolve(off);
  current = off;
}

/**
 * 서버가 이미 읽은 로그인 계정(마이페이지 틀, MeAccountPrimer) — 이 화면이 아직 아무것도 받지 않았을 때만 그 답으로 둔다.
 * 머리가 같은 값을 다시 묻지 않는다. 받은 로그인 답과 같은 규칙을 따른다(로그인·로그아웃은 새 문서로 열려 다시 묻는다).
 * 그리는 중에 부르므로 구독자에게 알리지 않는다 — 구독을 붙일 때 바뀐 값을 읽는다
 */
export function primeMeAccount(account: MeAccount): void {
  if (typeof window === "undefined" || state) return;
  const primed: MeState = { status: "ok", account };
  state = Promise.resolve(primed);
  answeredAt = Date.now();
  current = primed;
}

/** 이 화면에서 바꾼 계정 값(닉네임) — 다시 묻지 않고 머리 메뉴에 바로 그린다 */
export function patchMeAccount(patch: { user: Partial<MeAccount["user"]> }): void {
  if (current?.status !== "ok" || !current.account) return;
  const next: MeState = { status: "ok", account: { ...current.account, user: { ...current.account.user, ...patch.user } } };
  state = Promise.resolve(next);
  settle(next);
}

/** 답이 바뀔 때마다 — 저장 동기화가 묻지 못한 뒤 받은 답·다른 탭 로그인을 따라 다시 맞춘다 */
export function subscribeMeState(listener: () => void) {
  meListeners.add(listener);
  return () => { meListeners.delete(listener); };
}

export const meStateSnapshot = (): MeState | undefined => current;

/** 아직 모르면 undefined. 묻지 못했으면 화면으로 돌아오거나 다시 이어질 때 다시 묻는다 */
export function useMeState(): MeState | undefined {
  const value = useSyncExternalStore(subscribeMeState, meStateSnapshot, () => undefined);
  useEffect(() => { void loadMeState(); }, []);
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
    // 방금 로그인 답(또는 다른 부품)이 숫자를 채웠으면 다시 묻지 않는다
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
