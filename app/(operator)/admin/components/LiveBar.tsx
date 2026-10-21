"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clockLabel, createRefreshScheduler, freshCookie, hasUnsaved, isTextEntry, PAUSE_LABELS, readLivePreference, refreshPolicy,
  writeLivePreference, type PauseReason } from "../live-refresh";
import { renderedAtSnapshot, subscribeRenderedAt } from "./render-clock";
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

/** 자동 갱신이 켜져 있는가 — 화면 글자(운영센터 머리의 "화면 10초")도 같은 값을 본다 */
export function useLiveRefreshEnabled(): boolean {
  return useSyncExternalStore(subscribe, liveSnapshot, serverSnapshot);
}

/** 바퀴·스크롤은 잦다 — 이 간격에 한 번만 조작으로 센다 */
const SCROLL_THROTTLE_MS = 500;

/**
 * 모든 관리자 화면 머리의 갱신 줄 — 자동 갱신 켜기·끄기, 지금 새로고침, 마지막 갱신 시각.
 *
 * 운영센터에만 있던 자동 갱신(LiveRefresh)을 관리자 틀로 옮겼다. 그 단추는 누르면 말없이 멈췄다 — 지금은 켜짐·꺼짐을
 * 글자로 보이는 스위치이고, 고른 것은 이 브라우저에 기억한다. "새로고침"은 따로다: 5초 쿠키를 걸어 서버가 1분 캐시를 건너뛰고,
 * 자동 갱신과 다른 transition 이라 자동 갱신이 도는 중에도 누를 수 있다(누르면 그 위에 새로 읽는다).
 *
 * 다시 읽기는 router.refresh() — 레이아웃(메뉴 배지)까지 서버가 다시 그리고 화면의 입력·스크롤은 그대로다.
 * 건너뛰는 때: 창이 가려졌을 때, 글자를 넣는 칸에 있을 때, 저장하지 않은 변경([data-dirty]·손댄 폼)이나 열린 확인 창이 있을 때,
 * 화면마다 정한 시간 안에 누르거나 키를 치거나 스크롤했을 때(refreshPolicy). 다시 읽는 동안은 또 부르지 않는다(createRefreshScheduler).
 * 뒤로·앞으로 가기는 담아 둔 화면을 보이므로 곧바로 다시 읽는다.
 * "마지막 갱신"은 화면(페이지)을 서버가 그린 시각이다(PageStamp) — 레이아웃 시각(fallbackAt)은 아직 화면이 알리기 전에만 쓴다.
 */
export function LiveBar({ fallbackAt }: {
  /** 레이아웃을 그린 서버 시각 — 화면이 그린 시각을 알리기 전의 자리 */
  fallbackAt: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const policy = refreshPolicy(pathname);
  const live = useLiveRefreshEnabled();
  const pageAt = useSyncExternalStore(subscribeRenderedAt, renderedAtSnapshot, () => null);
  const shownAt = pageAt ?? fallbackAt;
  // 멈춘 까닭은 그 화면에서만 — 다른 화면으로 옮기면 지운다
  const [paused, setPaused] = useState<{ path: string; reason: PauseReason | null }>({ path: pathname, reason: null });
  const pausedReason = paused.path === pathname ? paused.reason : null;
  const [autoPending, startAuto] = useTransition();
  const [manualPending, startManual] = useTransition();
  const [scheduler] = useState(() => createRefreshScheduler());
  const manualBusy = useRef(false);
  /** 이 화면에서 글자를 넣었고 아직 보내지 않은 폼 — 체크·고르기는 다시 그려도 그대로라 세지 않는다(그런 폼은 [data-dirty] 로 직접 알린다) */
  const touched = useRef(new Set<HTMLFormElement>());

  // 화면을 옮기면 손댄 폼 기록은 지난 화면 것이다
  useEffect(() => { touched.current = new Set(); }, [pathname]);

  useEffect(() => {
    const content = () => document.getElementById("admin-content");
    let scrolledAt = -Infinity;
    const onInput = (event: Event) => {
      scheduler.input();
      if (!(event.target instanceof Element) || !isTextEntry(event.target)) return;
      const form = event.target.closest("form");
      if (form && content()?.contains(form)) touched.current.add(form);
    };
    const onSent = (event: Event) => { if (event.target instanceof HTMLFormElement) touched.current.delete(event.target); };
    const onPress = () => scheduler.input();
    const onScroll = () => {
      const at = Date.now();
      if (at - scrolledAt < SCROLL_THROTTLE_MS) return;
      scrolledAt = at;
      scheduler.input();
    };
    const passive = { capture: true, passive: true } as const;
    document.addEventListener("input", onInput, true);
    document.addEventListener("submit", onSent, true);
    document.addEventListener("reset", onSent, true);
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("keydown", onPress, true);
    document.addEventListener("wheel", onScroll, passive);
    document.addEventListener("scroll", onScroll, passive);
    return () => {
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("submit", onSent, true);
      document.removeEventListener("reset", onSent, true);
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("keydown", onPress, true);
      document.removeEventListener("wheel", onScroll, passive);
      document.removeEventListener("scroll", onScroll, passive);
    };
  }, [scheduler]);

  useEffect(() => { if (!autoPending) scheduler.settled(); }, [autoPending, scheduler]);
  useEffect(() => { manualBusy.current = manualPending; }, [manualPending]);

  useEffect(() => {
    if (!live) return;
    const tick = () => {
      const unsaved = hasUnsaved(document.getElementById("admin-content")) || [...touched.current].some((form) => form.isConnected);
      const next = scheduler.tick({ visible: document.visibilityState === "visible", editing: isTextEntry(document.activeElement),
        unsaved, idleMs: policy.idleMs, manualBusy: manualBusy.current });
      setPaused((prev) => prev.path === pathname && prev.reason === next.paused ? prev : { path: pathname, reason: next.paused });
      if (next.refresh) startAuto(() => { router.refresh(); });
    };
    const timer = setInterval(tick, policy.intervalMs);
    // 창으로 돌아오면 곧바로 한 번 — 묵은 숫자를 보이지 않게(조작·입력 규칙은 그대로)
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    // 뒤로·앞으로 가기는 담아 둔 화면(옛 숫자)을 보인다 — 조작 시간과 상관없이 곧바로 다시 읽는다
    const onHistory = () => { if (scheduler.now()) startAuto(() => { router.refresh(); }); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("popstate", onHistory);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("popstate", onHistory);
    };
  }, [live, policy.intervalMs, policy.idleMs, router, scheduler, pathname]);

  const toggle = () => {
    if (live) setPaused({ path: pathname, reason: null });
    chooseLive(!live);
  };
  // 막지 않는다(disabled 면 포커스를 잃는다) — 읽는 중에 누르면 그 클릭만 버린다
  const refreshNow = () => {
    if (manualPending) return;
    document.cookie = freshCookie();
    startManual(() => { router.refresh(); });
  };

  const seconds = policy.intervalMs / 1000;
  const idle = policy.idleMs / 1000;
  const status = manualPending || autoPending ? "다시 읽는 중…" : !live ? "자동 갱신을 껐습니다 — 새로고침을 눌러 읽습니다"
    : pausedReason ? PAUSE_LABELS[pausedReason] : `${seconds}초마다 다시 읽음`;
  const rule = `이 화면은 ${seconds}초마다 다시 읽습니다${idle ? ` — 누르거나 키를 치거나 스크롤한 뒤 ${idle >= 60 ? `${idle / 60}분` : `${idle}초`} 동안은 쉽니다` : ""}.`;
  return (
    <div className="admin-live-bar" role="group" aria-label="화면 갱신">
      {/* 알림 영역(aria-live)으로 두지 않는다 — 10초마다 "다시 읽는 중"을 읽어 주면 화면 낭독기가 쉬지 못한다 */}
      <span className="admin-live-status">{status}</span>
      <span className="admin-live-clock">마지막 갱신 <time dateTime={shownAt}>{clockLabel(shownAt)}</time></span>
      {/* 스위치다 — 이름은 늘 "자동 갱신", 켜짐·꺼짐은 aria-checked 와 보이는 글자로(ADM-31: 색 점만으로 가르지 않는다) */}
      <button type="button" role="switch" aria-checked={live} aria-label="자동 갱신" className="admin-live-toggle" onClick={toggle}
        title={live ? `자동 갱신 켜짐 — ${rule} 누르면 끕니다(이 브라우저에 기억).` : "자동 갱신 꺼짐 — 누르면 다시 켭니다(이 브라우저에 기억)."}>
        <span aria-hidden="true"><StatusDot state={live ? "ok" : "idle"} label={live ? `자동 갱신 켜짐 · ${seconds}초` : "자동 갱신 꺼짐"} /></span>
      </button>
      <button type="button" className="admin-live-refresh" aria-disabled={manualPending || undefined} onClick={refreshNow}
        title="지금 다시 읽습니다 — 서버의 1분 캐시도 건너뜁니다(1분에 몇 번까지만)">새로고침</button>
    </div>
  );
}
