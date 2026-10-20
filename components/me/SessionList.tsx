"use client";

import { useState } from "react";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatDate } from "@/lib/i18n/format";
import type { AccountSession } from "@/lib/me/account";
import { accountError } from "./AccountForms";

/** 로그인된 기기 — 하나씩 또는 지금 기기만 남기고 모두 로그아웃. 줄 id 는 토큰 해시 앞 16자 */
export function SessionList({ csrfToken, sessions: initial }: { csrfToken: string; sessions: AccountSession[] }) {
  const t = useTranslations("me");
  const locale = useLocale();
  const now = useServerNow();
  const [sessions, setSessions] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const others = sessions.filter((session) => !session.current);

  async function revoke(session: AccountSession) {
    if (busy) return;
    setBusy(session.id);
    setStatus(null);
    try {
      const response = await fetch(`/api/me/sessions/${session.id}`, { method: "DELETE", headers: { "x-csrf-token": csrfToken } });
      // 이미 끝난 세션(404)도 목록에서 뺀다
      if (!response.ok && response.status !== 404) {
        setStatus({ kind: "error", text: t(await accountError(response)) });
        return;
      }
      setSessions((list) => list.filter((item) => item.id !== session.id));
      setStatus({ kind: "ok", text: t("account.session.revoked", { device: session.deviceLabel ?? t("account.session.unknown") }) });
    } catch {
      setStatus({ kind: "error", text: t("account.session.failed") });
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    if (busy) return;
    setBusy("others");
    setStatus(null);
    try {
      const response = await fetch("/api/me/sessions/revoke-others", { method: "POST", headers: { "x-csrf-token": csrfToken } });
      if (!response.ok) {
        setStatus({ kind: "error", text: t(await accountError(response)) });
        return;
      }
      const body = await response.json() as { revoked: number };
      setSessions((list) => list.filter((item) => item.current));
      setStatus({ kind: "ok", text: t("account.session.othersDone", { count: body.revoked }) });
    } catch {
      setStatus({ kind: "error", text: t("account.session.failed") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <ul className="me-kvs">
        {sessions.map((session) => {
          const via = session.provider === "github" || session.provider === "email" ? t(`account.session.via.${session.provider}`) : null;
          const seen = session.lastSeenAt ?? session.createdAt;
          return (
            <li className="me-kv" key={session.id}>
              <div className="me-kv-l">
                <span className="me-logo me-logo-device" aria-hidden="true">{/iPhone|Android|iPad/.test(session.deviceLabel ?? "") ? t("account.session.phone") : t("account.session.pc")}</span>
                <div className="me-kv-x">
                  <span className="me-kv-t">{session.deviceLabel ?? t("account.session.unknown")}</span>
                  <span className="me-kv-s">
                    {[session.current && t("account.session.current"), via, t("account.session.lastSeen", { date: formatDate(seen, now, locale) })].filter(Boolean).join(" · ")}
                  </span>
                </div>
              </div>
              {session.current ? <span className="me-note">{t("account.session.inUse")}</span>
                : <button type="button" className="me-btn me-btn-sm" disabled={busy !== null} onClick={() => revoke(session)}
                  aria-label={t("account.session.logoutDevice", { device: session.deviceLabel ?? t("account.session.unknown") })}>{t("account.session.logout")}</button>}
            </li>
          );
        })}
      </ul>
      {others.length > 0 && <div className="me-acts">
        <button type="button" className="me-btn me-btn-danger" disabled={busy !== null} onClick={revokeOthers}>{t("account.session.logoutOthers")}</button>
      </div>}
      <p className={status?.kind === "error" ? "me-error" : "me-ok"} role="status" aria-live="polite">{status?.text}</p>
    </>
  );
}
