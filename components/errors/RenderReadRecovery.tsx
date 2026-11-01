"use client";

import { useEffect } from "react";
import { RENDER_RECOVERY_QUERY, renderRecoveryUrl, startRenderRecovery } from "@/lib/web/render-recovery";
import { renderRecoveryCookie } from "@/lib/web/recovery-cache";

/** Location replacement issues a document GET, including after an action error.
 * It never repeats that action/form submission. Each attempt has a fresh edge key. */
function recoverDocument(): void {
  try {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    const target = renderRecoveryUrl(window.location.href, nonce);
    if (!target) return;
    // Set only after the controller claims an attempt, immediately before GET.
    try { document.cookie = renderRecoveryCookie(window.location.protocol === "https:"); } catch { /* cookies disabled */ }
    window.location.replace(target);
  } catch {
    // Restricted crypto/navigation retains the existing manual recovery UI.
  }
}

/** Only re-fetch rendering. Never submit a form or call a server action here. */
export function useRenderRecovery(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    try {
      return startRenderRecovery(recoverDocument, {
        storage: window.sessionStorage,
        now: Date.now,
        automaticContinuation: new URL(window.location.href).searchParams.has(RENDER_RECOVERY_QUERY),
        available: () => document.visibilityState === "visible" && navigator.onLine,
        schedule: (run, delay) => window.setTimeout(run, delay),
        cancel: (timer) => window.clearTimeout(timer),
        onAvailabilityChange: (run) => {
          document.addEventListener("visibilitychange", run);
          window.addEventListener("online", run);
          window.addEventListener("offline", run);
          return () => {
            document.removeEventListener("visibilitychange", run);
            window.removeEventListener("online", run);
            window.removeEventListener("offline", run);
          };
        },
      });
    } catch {
      // Reading sessionStorage itself may throw in restricted browsers.
    }
  }, [enabled]);
}

/** Known read failures can render a useful fallback without throwing to error.tsx. */
export function RenderReadRecovery() {
  useRenderRecovery(true);
  return null;
}
