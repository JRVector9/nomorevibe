"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatDate } from "@/lib/i18n/format";
import type { MessageKey } from "@/lib/i18n/messages";
import { localePath } from "@/lib/i18n/routing";
import { DISPLAY_NAME_CHANGE_DAYS } from "@/lib/me/contract";
import { DISPLAY_NAME_MAX, DISPLAY_NAME_MIN } from "@/lib/me/profile";
import { patchMeAccount } from "./account-store";

/** 계정 탭의 쓰기 단추들 — 닉네임, 내 데이터 받기, 계정 삭제, 로그아웃. 쓰기는 모두 x-csrf-token 을 붙인다 */

type ErrorKey = Extract<MessageKey<"me">, `account.error.${string}`>;
const ERRORS: Record<string, ErrorKey> = {
  invalid_display_name: "account.error.invalidName",
  reserved_display_name: "account.error.reservedName",
  display_name_change_limited: "account.error.nameLimited",
  delete_confirmation_mismatch: "account.error.confirmMismatch",
  export_rate_limited: "account.error.exportLimited",
  profile_rate_limited: "account.error.rateLimited",
  sessions_rate_limited: "account.error.rateLimited",
  delete_rate_limited: "account.error.rateLimited",
  login_required: "account.error.loginRequired",
  public_auth_unavailable: "account.error.unavailable",
};

export async function accountError(response: Response): Promise<ErrorKey> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return (typeof body?.error === "string" && ERRORS[body.error]) || "account.error.generic";
}

export function ProfileForm({ csrfToken, displayName, nextNameChangeAt }: { csrfToken: string; displayName: string; nextNameChangeAt: string | null }) {
  const t = useTranslations("me");
  const locale = useLocale();
  const now = useServerNow();
  const router = useRouter();
  const formId = useId();
  const [name, setName] = useState(displayName);
  const [next, setNext] = useState(nextNameChangeAt);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; key: ErrorKey | "account.nicknameSaved" } | null>(null);
  const locked = next !== null && Date.parse(next) > now.getTime();
  const length = [...draft.trim()].length;
  const valid = length >= DISPLAY_NAME_MIN && length <= DISPLAY_NAME_MAX;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/me/profile", { method: "PATCH", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ displayName: draft }) });
      if (!response.ok) {
        setMessage({ kind: "error", key: await accountError(response) });
        return;
      }
      const body = await response.json() as { displayName: string; nextNameChangeAt: string | null };
      setName(body.displayName);
      setNext(body.nextNameChangeAt);
      setOpen(false);
      setMessage({ kind: "ok", key: "account.nicknameSaved" });
      // 아바타 메뉴는 이 화면의 계정 값을 고치고(다시 묻지 않는다), 마이페이지 머리는 서버가 다시 그린다
      patchMeAccount({ user: { displayName: body.displayName } });
      router.refresh();
    } catch {
      setMessage({ kind: "error", key: "account.error.generic" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="me-kvs">
      <div className="me-kv">
        <div className="me-kv-x">
          <span className="me-kv-t">{t("account.nickname")} · {name}</span>
          <span className="me-kv-s">{t("account.nicknameHint", { min: DISPLAY_NAME_MIN, max: DISPLAY_NAME_MAX, days: DISPLAY_NAME_CHANGE_DAYS })}</span>
          {locked && <span className="me-kv-s">{t("account.nicknameNext", { date: formatDate(next, now, locale) })}</span>}
        </div>
        <button type="button" className="me-btn me-btn-sm" disabled={locked && !open} aria-expanded={open} aria-controls={formId}
          onClick={() => { if (!open) setDraft(name); setOpen(!open); setMessage(null); }}>{t("account.nicknameChange")}</button>
      </div>
      {open && (
        <form id={formId} className="me-edit" onSubmit={submit} aria-label={t("account.nicknameNew")}>
          <label className="me-edit-k" htmlFor={`${formId}-input`}>{t("account.nicknameNew")}</label>
          <input id={`${formId}-input`} className="me-input" value={draft} maxLength={DISPLAY_NAME_MAX + 8} autoComplete="off" autoFocus disabled={busy}
            aria-invalid={!valid || undefined} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} />
          <div className="me-edit-foot">
            <span className={`me-count${length > DISPLAY_NAME_MAX ? " over" : ""}`}>{length}/{DISPLAY_NAME_MAX}</span>
            <span className="me-acts">
              <button type="button" className="me-btn" onClick={() => setOpen(false)} disabled={busy}>{t("account.nicknameCancel")}</button>
              <button type="submit" className="me-btn me-btn-pri" disabled={busy || !valid || draft.trim() === name}>{t("account.nicknameSave")}</button>
            </span>
          </div>
        </form>
      )}
      {message && <p className={message.kind === "error" ? "me-error" : "me-ok"} role={message.kind === "error" ? "alert" : "status"}>{t(message.key)}</p>}
    </div>
  );
}

/** 내 데이터 받기 — POST(CSRF)로 받아 파일로 내린다. 실패(하루 2번 넘음 등)는 파일이 아니라 글로 알린다 */
export function ExportData({ csrfToken }: { csrfToken: string }) {
  const t = useTranslations("me");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);

  async function download() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/me/export", { method: "POST", cache: "no-store", headers: { "x-csrf-token": csrfToken } });
      if (!response.ok) {
        setError(await accountError(response));
        return;
      }
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "nomorevibe-my-data.json";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setError("account.error.generic");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="me-kv">
      <div className="me-kv-x">
        <span className="me-kv-t">{t("account.export")}</span>
        <span className="me-kv-s">{t("account.exportHint")}</span>
        {error && <span className="me-error" role="alert">{t(error)}</span>}
      </div>
      <button type="button" className="me-btn me-btn-sm" onClick={download} disabled={busy}>{t(busy ? "account.busy" : "account.exportCta")}</button>
    </div>
  );
}

/** 계정 삭제 — 지금 닉네임을 그대로 적어야 단추가 켜진다. 서버도 같은 값을 다시 본다 */
export function DeleteAccount({ csrfToken, displayName }: { csrfToken: string; displayName: string }) {
  const t = useTranslations("me");
  const locale = useLocale();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const matches = confirm.trim() === displayName;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !matches) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/me/delete", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ confirm }) });
      if (!response.ok) {
        setError(await accountError(response));
        setBusy(false);
        return;
      }
      window.location.assign(localePath(locale, "/"));
    } catch {
      setError("account.error.generic");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="me-kv">
        <div className="me-kv-x">
          <span className="me-kv-t me-down">{t("account.delete")}</span>
          <span className="me-kv-s">{t("account.deleteHint")}</span>
        </div>
        <button type="button" className="me-btn me-btn-sm me-btn-danger" aria-expanded={open} aria-controls={formId} onClick={() => setOpen(!open)}>{t("account.deleteOpen")}</button>
      </div>
      <form id={formId} className="me-edit" hidden={!open} onSubmit={submit}>
        <p className="me-edit-k">{t("account.deleteWarn")}</p>
        <p className="me-hint">{t("account.deleteDetail")}</p>
        <label className="me-edit-k" htmlFor={`${formId}-confirm`}>{t("account.deleteConfirmLabel", { name: displayName })}</label>
        <input id={`${formId}-confirm`} className="me-input" value={confirm} autoComplete="off" disabled={busy} onChange={(event) => setConfirm(event.target.value)} />
        <div className="me-edit-foot">
          {error ? <span className="me-error" role="alert">{t(error)}</span> : <span />}
          <button type="submit" className="me-btn me-btn-danger-solid" disabled={busy || !matches}>{t(busy ? "account.deleteBusy" : "account.deleteSubmit")}</button>
        </div>
      </form>
    </>
  );
}

/** 맨 아래 로그아웃 — 머리 메뉴와 같은 경로 */
export function LogoutButton({ csrfToken }: { csrfToken: string }) {
  const t = useTranslations("me");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function logout() {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch("/api/auth/user/logout", { method: "POST", headers: { "x-csrf-token": csrfToken } });
      if (!response.ok) throw new Error();
      window.location.assign(localePath(locale, "/me"));
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  return (
    <div className="me-logout">
      <button type="button" className="me-btn me-btn-wide" onClick={logout} disabled={busy}>{t(busy ? "account.busy" : "account.logout")}</button>
      {error && <p className="me-error" role="alert">{t("account.error.generic")}</p>}
    </div>
  );
}
