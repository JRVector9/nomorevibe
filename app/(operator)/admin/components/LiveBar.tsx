"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BUSY_LIMIT_MS, clockLabel, freshCookie, isTextEntry, PAUSE_LABELS, pauseReason, readLivePreference, refreshPolicy,
  writeLivePreference, type PauseReason } from "../live-refresh";
import { StatusDot } from "./StatusDot";

const storage = () => (typeof window === "undefined" ? null : window.localStorage);

/*
 * 켜짐·꺼짐은 브라우저 저장소에 둔다(useSyncExternalStore). 저장소가 막혀 있어도(사생활 창 등) 이 창 안에서는 바뀌도록
 * 고른 값을 메모리에도 들고, 다른 탭이 바꾸면(storage 사건) 저장소를 다시 읽는다. 서버 그리기와 첫 그리기는 켜짐이다.
 */
let chosen: boolean | null = null;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  const onStorage = () => { chosen = null; listener(); };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}
const liveSnapshot = () => chosen ?? readLivePreference(storage);
const serverSnapshot = () => true;
function chooseLive(live: boolean) {
  chosen = live;
  writeLivePreference(storage, live);
  for (const listener of listeners) listener();
}

/**
 * 모든 관리자 화면 머리의 갱신 줄 — 자동 갱신 켜기·끄기, 지금 새로고침, 마지막 갱신 시각.
 *
 * 운영센터에만 있던 자동 갱신(LiveRefresh)을 관리자 틀로 옮겼다. 그 단추는 누르면 말없이 멈췄다 — 지금은 켜짐·꺼짐을
 * 글자로 보이는 스위치이고, 고른 것은 이 브라우저에 기억한다. "새로고침"은 따로다: 5초 쿠키를 걸어 서버가 60초 캐시를 건너뛴다.
 *
 * 다시 읽기는 router.refresh() — 레이아웃(메뉴 배지)까지 서버가 다시 그리고 화면의 입력·스크롤은 그대로다.
 * 건너뛰는 때: 창이 가려졌을 때, 글자를 넣는 칸에 있을 때, 저장하지 않은 변경([data-dirty] 또는 손댄 폼)이 있을 때,
 * 화면마다 정한 시간 안에 누르거나 키를 쳤을 때(refreshPolicy). 다시 읽는 동안은 또 부르지 않는다(느린 조각이 1분 넘게 막으면 다시 부른다).
 */
export function LiveBar({ shownAt }: {
  /** 화면에 보이는 숫자를 서버가 읽은 시각(ISO) — 레이아웃이 그린 시각과 화면을 옮긴 뒤 다시 받은 시각 중 늦은 것 */
  shownAt: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const policy = refreshPolicy(pathname);
  const live = useSyncExternalStore(subscribe, liveSnapshot, serverSnapshot);
  const [paused, setPaused] = useState<PauseReason | null>(null);
  const [pending, start] = useTransition();
  /** 다시 읽기를 부른 시각 — 끝나면 null */
  const busy = useRef<number | null>(null);
  const lastInput = useRef(0);
  /** 이 화면에서 글자를 넣었고 아직 보내지 않은 폼 — 체크·고르기는 다시 그려도 그대로라 세지 않는다(그런 폼은 [data-dirty] 로 직접 알린다) */
  const touched = useRef(new Set<HTMLFormElement>());

  // 화면을 옮기면 손댄 폼 기록은 지난 화면 것이다
  useEffect(() => { touched.current = new Set(); }, [pathname]);

  useEffect(() => {
    const content = () => document.getElementById("admin-content");
    const onInput = (event: Event) => {
      lastInput.current = Date.now();
      if (!(event.target instanceof Element) || !isTextEntry(event.target)) return;
      const form = event.target.closest("form");
      if (form && content()?.contains(form)) touched.current.add(form);
    };
    const onSent = (event: Event) => { if (event.target instanceof HTMLFormElement) touched.current.delete(event.target); };
    const onPress = () => { lastInput.current = Date.now(); };
    document.addEventListener("input", onInput, true);
    document.addEventListener("submit", onSent, true);
    document.addEventListener("reset", onSent, true);
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("keydown", onPress, true);
    return () => {
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("submit", onSent, true);
      document.removeEventListener("reset", onSent, true);
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("keydown", onPress, true);
    };
  }, []);

  useEffect(() => { if (!pending) busy.current = null; }, [pending]);

  useEffect(() => {
    if (!live) return;
    const tick = () => {
      const unsaved = !!document.querySelector("#admin-content [data-dirty]")
        || [...touched.current].some((form) => form.isConnected);
      const reason = pauseReason({ visible: document.visibilityState === "visible", editing: isTextEntry(document.activeElement),
        unsaved, idleForMs: Date.now() - lastInput.current, idleMs: policy.idleMs });
      setPaused(reason);
      if (reason) return;
      if (busy.current !== null && Date.now() - busy.current < BUSY_LIMIT_MS) return;
      busy.current = Date.now();
      start(() => { router.refresh(); });
    };
    const timer = setInterval(tick, policy.intervalMs);
    // 창으로 돌아오면 곧바로 한 번 — 묵은 숫자를 보이지 않게
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [live, policy.intervalMs, policy.idleMs, router]);

  const toggle = () => {
    if (live) setPaused(null);
    chooseLive(!live);
  };
  const refreshNow = () => {
    document.cookie = freshCookie();
    busy.current = Date.now();
    start(() => { router.refresh(); });
  };

  const seconds = policy.intervalMs / 1000;
  const status = pending ? "다시 읽는 중…" : !live ? "자동 갱신을 껐습니다 — 새로고침을 눌러 읽습니다" : paused ? PAUSE_LABELS[paused] : `${seconds}초마다 다시 읽음`;
  return (
    <div className="admin-live-bar" role="group" aria-label="화면 갱신">
      {/* 알림 영역(aria-live)으로 두지 않는다 — 10초마다 "다시 읽는 중"을 읽어 주면 화면 낭독기가 쉬지 못한다 */}
      <span className="admin-live-status">{status}</span>
      <span className="admin-live-clock">마지막 갱신 <time dateTime={shownAt}>{clockLabel(shownAt)}</time></span>
      {/* 스위치다 — 누르면 켜짐·꺼짐이 바뀌고 글자로 보인다(ADM-31: 색 점만으로 가르지 않는다) */}
      <button type="button" role="switch" aria-checked={live} className="admin-live-toggle" onClick={toggle}
        title={live ? `자동 갱신 켜짐 — 이 화면은 ${seconds}초마다 다시 읽습니다. 누르면 끕니다(이 브라우저에 기억).`
          : "자동 갱신 꺼짐 — 누르면 다시 켭니다(이 브라우저에 기억)."}>
        <StatusDot state={live ? "ok" : "idle"} label={live ? `자동 갱신 켜짐 · ${seconds}초` : "자동 갱신 꺼짐"} />
      </button>
      <button type="button" className="admin-live-refresh" disabled={pending} onClick={refreshNow}
        title="지금 다시 읽습니다 — 서버의 1분 캐시도 건너뜁니다(1분에 몇 번까지만)">새로고침</button>
    </div>
  );
}
