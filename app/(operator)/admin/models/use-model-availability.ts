"use client";

import { useSyncExternalStore } from "react";
import type { ModelPickerAvailability } from "@/lib/operations/model-picker-availability";

type State = Readonly<{ value: ModelPickerAvailability | null; loading: boolean; failed: boolean }>;
const initial: State = { value: null, loading: false, failed: false };
let state = initial, pending: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
function update(next: State) { state = next; listeners.forEach(listener => listener()); }

/** All pickers share one request; opening any picker refreshes the observed shared device slots. */
export function refreshModelAvailability(): Promise<void> {
  if (pending) return pending;
  update({ ...state, loading: true });
  pending = (async () => {
    try {
      const response = await fetch("/admin/models/availability", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error("unavailable");
      const result = await response.json() as { ok?: boolean; availability?: ModelPickerAvailability };
      if (!result.ok || !result.availability || !Array.isArray(result.availability.connections)) throw new Error("unavailable");
      update({ value: result.availability, loading: false, failed: false });
    } catch { update({ value: null, loading: false, failed: true }); }
  })().finally(() => { pending = null; });
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
