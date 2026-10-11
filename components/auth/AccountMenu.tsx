"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type PublicAccount = { user: { id: number; displayName: string }; csrfToken: string };

export function AccountMenu() {
  const [account, setAccount] = useState<PublicAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/me", { cache: "no-store", signal: abort.signal }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json();
      if (body.user && body.csrfToken) setAccount(body);
    }).catch(() => {});
    return () => abort.abort();
  }, []);

  async function logout() {
    if (!account || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/user/logout", { method: "POST", headers: { "x-csrf-token": account.csrfToken } });
      if (!response.ok) throw new Error();
      window.location.reload();
    } catch {
      setError("로그아웃하지 못했습니다. 다시 시도해 주세요.");
      setBusy(false);
    }
  }

  if (!account) return <Link prefetch={false} href="/login" className="text-[14px] font-semibold">로그인</Link>;
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <span className="max-w-28 truncate" title={account.user.displayName}>{account.user.displayName}</span>
      <button type="button" disabled={busy} onClick={logout} className="min-h-11 px-1 text-fg-2 disabled:opacity-50">{busy ? "처리 중…" : "로그아웃"}</button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
