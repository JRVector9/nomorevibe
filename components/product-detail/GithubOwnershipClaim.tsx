"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { recheckMeState } from "@/components/me/account-store";
import { makerRequest } from "@/components/me/projects/maker-request";
import { trackAttrs } from "@/lib/analytics/attrs";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import type { MessageKey } from "@/lib/i18n/messages";
import { localePath, stripLocale } from "@/lib/i18n/routing";
import type { ClaimItem } from "@/lib/me/maker-claims";
import type { RepositoryProofChallenge } from "@/lib/me/maker-repo-proof";

type NoticeKey = Extract<MessageKey<"detail">, `owner.claim.${string}`>;
const REJECTIONS: Partial<Record<ClaimItem["result"], NoticeKey>> = {
  owner_mismatch: "owner.claim.ownerMismatch",
  repo_not_found: "owner.claim.repoUnavailable",
  repo_not_public: "owner.claim.repoUnavailable",
  repo_unverified: "owner.claim.repoUnverified",
  repo_replaced: "owner.claim.repoReplaced",
  not_found: "owner.claim.notFound",
  no_github_repo: "owner.claim.notFound",
};

/** Cached public HTML carries no session. Only an explicit click can claim this exact product. */
export function GithubOwnershipClaim({ productId, slug, authEnabled = true, githubEnabled = true }: { productId: number; slug: string; authEnabled?: boolean; githubEnabled?: boolean }) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [notice, setNotice] = useState<NoticeKey | null>(null);
  const [challenge, setChallenge] = useState<RepositoryProofChallenge | null>(null);
  const pending = useRef(false);

  function signIn(connectGithub: boolean) {
    const path = localePath(locale, `/p/${encodeURIComponent(slug)}`);
    const current = new URL(window.location.href);
    const search = stripLocale(current.pathname) === stripLocale(path) ? current.search : "";
    const returnTo = `${path}${search}#owner-claim`;
    window.location.assign(localePath(locale, `/login?${connectGithub ? "connectGithub=1&" : ""}returnTo=${encodeURIComponent(returnTo)}`));
  }

  async function claim() {
    if (pending.current || verified) return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const session = await recheckMeState();
      if (session.status !== "ok") { setNotice("owner.claim.unavailable"); return; }
      if (!session.account) { signIn(true); return; }
      const result = await makerRequest<{ results: ClaimItem[] }>("/api/maker/claims", "POST", session.account.csrfToken, { productIds: [productId] });
      if (!result.ok) {
        if (result.code === "login_required" || result.code === "github_login_required") { signIn(true); return; }
        setNotice(result.code === "rate_limited" ? "owner.claim.rateLimited"
          : result.code === "invalid_csrf" || result.code === "invalid_origin" ? "owner.claim.sessionExpired" : "owner.claim.unavailable");
        return;
      }
      const item = result.data.results.find((item) => item.productId === productId && item.slug === slug);
      if (!item) { setNotice("owner.claim.unavailable"); return; }
      if (item.result === "verified" || item.result === "already_verified") {
        setVerified(true);
        setNotice("owner.claim.verified");
      } else if (item.result === "org_repo_not_supported_yet") {
        setNotice("owner.claim.orgRepository");
      } else {
        setNotice(REJECTIONS[item.result] ?? "owner.claim.unavailable");
      }
    } catch {
      // A lost response may follow a successful write; retrying the existing claim API is idempotent.
      setNotice("owner.claim.unavailable");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function repositoryFile(complete: boolean) {
    if (pending.current || verified || (complete && !challenge)) return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const session = await recheckMeState();
      if (session.status !== "ok") { setNotice("owner.claim.unavailable"); return; }
      if (!session.account) { signIn(false); return; }
      const result = await makerRequest<RepositoryProofChallenge | { result: "verified" | "already_verified" }>("/api/maker/claims/repo-file", "POST", session.account.csrfToken,
        { productId, ...(complete && challenge ? { token: challenge.token } : {}) });
      if (!result.ok) {
        if (result.code === "login_required") { signIn(false); return; }
        const errors: Record<string, NoticeKey> = {
          repo_proof_invalid: "owner.claim.proofExpired", repo_proof_missing: "owner.claim.proofMissing", repo_proof_repository_changed: "owner.claim.repoReplaced",
          repo_unverified: "owner.claim.repoUnverified", repo_replaced: "owner.claim.repoReplaced", repo_not_public: "owner.claim.repoUnavailable",
          product_not_found: "owner.claim.notFound", rate_limited: "owner.claim.rateLimited", invalid_csrf: "owner.claim.sessionExpired", invalid_origin: "owner.claim.sessionExpired",
        };
        setNotice(errors[result.code] ?? "owner.claim.unavailable");
        return;
      }
      if ("result" in result.data) { setVerified(true); setNotice("owner.claim.verified"); }
      else { setChallenge(result.data); }
    } catch { setNotice("owner.claim.unavailable"); }
    finally { pending.current = false; setBusy(false); }
  }

  if (!authEnabled) return <p className="mt-2 text-[13px] leading-5 text-fg-2" role="status">{t("owner.claim.disabled")}</p>;

  return <div className="mt-3" aria-busy={busy}>
    {verified ? <Link prefetch={false} href={localePath(locale, "/me/projects")}
      className="inline-flex min-h-11 items-center rounded-full bg-accent-solid px-5 text-[14px] font-medium text-white hover:opacity-90">
      {t("owner.claim.manage")}
    </Link> : <>{githubEnabled && <button type="button" disabled={busy} onClick={() => { void claim(); }}
      className="inline-flex min-h-11 items-center rounded-full bg-accent-solid px-5 text-[14px] font-medium text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
      {...trackAttrs("claim_start", { product_slug: slug, step: "claim" })}>
      {t(busy ? "owner.claim.checking" : "owner.claim.button")}
    </button>}
      <details className="mt-3">
        <summary className="cursor-pointer text-[13px] font-medium text-fg">{t("owner.claim.fileAlternative")}</summary>
        <p className="mt-2 text-[13px] leading-5 text-fg-2">{t("owner.claim.fileInstructions")}</p>
        <button type="button" disabled={busy} onClick={() => { void repositoryFile(false); }}
          className="mt-2 inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] font-medium disabled:opacity-60">
          {t(challenge ? "owner.claim.newFile" : "owner.claim.createFile")}
        </button>
        {challenge && <div className="mt-3 space-y-2 text-[13px] leading-5 text-fg-2">
          <p>{t("owner.claim.filePath")} <code className="break-all">{challenge.path}</code></p>
          <label className="block">{t("owner.claim.fileContent")}
            <textarea readOnly rows={4} value={challenge.token} className="mt-1 block w-full rounded-lg border border-line bg-bg-card p-2 font-mono text-[13px]" onFocus={(event) => event.currentTarget.select()} />
          </label>
          <a href={challenge.editUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-accent-ink underline underline-offset-2">{t("owner.claim.openGithub")}</a>
          <button type="button" disabled={busy} onClick={() => { void repositoryFile(true); }}
            className="block min-h-11 rounded-full bg-accent-solid px-4 text-[13px] font-medium text-white disabled:opacity-60">{t("owner.claim.checkFile")}</button>
        </div>}
      </details>
    </>}
    {!verified && <p className="mt-2 text-[13px] leading-5 text-fg-2">{t("owner.claim.returnHint")}</p>}
    {notice && <p role={verified ? "status" : "alert"} className="mt-2 text-[13px] leading-5 text-fg-2">{t(notice)}</p>}
  </div>;
}
