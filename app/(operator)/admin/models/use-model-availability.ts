"use client";

import { useSyncExternalStore } from "react";
import type { ModelPickerAvailability } from "@/lib/operations/model-picker-availability";

type State = Readonly<{ value: ModelPickerAvailability | null; loading: boolean; failed: boolean }>;
const initial: State = { value: null, loading: false, failed: false };
let state = initial, pending: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
/** 마지막으로 읽기를 끝낸 시각(성공·실패) — 고르기 상자를 스칠 때마다 다시 부르지 않게 */
let settledAt = -Infinity;
const listeners = new Set<() => void>();
function update(next: State) { state = next; listeners.forEach(listener => listener()); }

/** 고르기 상자를 누르거나 스칠 때 다시 읽는 간격 — 이보다 최근에 읽었으면 그 값을 쓴다(15초 주기 읽기는 그대로) */
export const MODEL_AVAILABILITY_FRESH_MS = 5_000;

/**
 * All pickers share one request; opening any picker refreshes the observed shared device slots.
 *
 * 다시 읽는 동안 화면 글자를 바꾸지 않는다(2026-11-08 운영자 「주기적으로 깜빡인다」). 전에는 15초마다·상자를 스칠 때마다 loading 을 먼저 알려
 * 모든 선택지와 상태 줄에 「· 갱신 중」이 붙었다 떨어졌고, 읽기에 실패하면 관측을 지워 모든 글자가 「상태 확인 못함」으로 바뀌었다 —
 * 글자 길이가 바뀌어 줄이 다시 감기고 열린 드롭다운 목록이 다시 그려졌다. 지금은 아직 관측이 없을 때만 loading 을 알리고,
 * 실패하면 마지막 관측을 그대로 두고 failed 만 알린다(관측 시각이 그대로라 오래된 값임이 보인다).
 */
export function refreshModelAvailability(): Promise<void> {
  if (pending) return pending;
  if (state.value && Date.now() - settledAt < MODEL_AVAILABILITY_FRESH_MS) return Promise.resolve();
  if (!state.value) update({ ...state, loading: true });
  pending = (async () => {
    try {
      const response = await fetch("/admin/models/availability", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error("unavailable");
      const result = await response.json() as { ok?: boolean; availability?: ModelPickerAvailability };
      if (!result.ok || !result.availability || !Array.isArray(result.availability.connections)) throw new Error("unavailable");
      update({ value: result.availability, loading: false, failed: false });
    } catch { update({ value: state.value, loading: false, failed: true }); }
  })().finally(() => { pending = null; settledAt = Date.now(); });
  return pending;
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshModelAvailability();
    timer = setInterval(refreshVisible, 15_000);
    document.addEventListener("visibilitychange", refreshVisible);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      if (timer !== null) clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", refreshVisible);
    }
  };
};
function refreshVisible() { if (!document.hidden) void refreshModelAvailability(); }
export function useModelAvailability(): State {
  return useSyncExternalStore(subscribe, () => state, () => initial);
}
/** 시험용 — 지금 나눠 쓰는 관측 */
export const modelAvailabilitySnapshot = (): State => state;
