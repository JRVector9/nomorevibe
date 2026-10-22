"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatDate } from "@/lib/i18n/format";
import type { FoundRepo } from "@/lib/me/maker";
import type { ClaimItem } from "@/lib/me/maker-claims";
import { makerErrorKey, makerRequest } from "./maker-request";
import { trackAttrs } from "@/lib/analytics/attrs";
import { trackEvents } from "@/lib/analytics/client";

type Notice = { key: string; text: string; ok: boolean };

/**
 * 프로젝트 추가로 확인하기 — GitHub 이름이 같은 저장소 목록(모두 확인·하나씩 확인)과 주소로 찾기.
 * 확인은 서버가 GitHub 숫자 ID 로 다시 맞춘다. 하나라도 확인되면 화면을 새로 받아 카드가 생긴다
 */
export function FoundReposBox({ csrfToken, linked, login, repos }: { csrfToken: string; linked: boolean; login: string | null; repos: FoundRepo[] }) {
  const t = useTranslations("me");
  const locale = useLocale();
  const now = useServerNow();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [address, setAddress] = useState("");

  function claimText(item: ClaimItem): string {
    const repo = item.repo ?? item.name ?? "";
    switch (item.result) {
      case "verified": return t("projects.claim.verified", { repo });
      case "already_verified": return t("projects.claim.already_verified", { repo });
      case "org_repo_not_supported_yet": return t("projects.claim.org_repo_not_supported_yet", { repo });
      case "owner_mismatch": return t("projects.claim.owner_mismatch", { repo });
      case "repo_not_found": return t("projects.claim.repo_not_found", { repo });
      case "repo_not_public": return t("projects.claim.repo_not_public", { repo });
      case "repo_unverified": return t("projects.claim.repo_unverified", { repo });
      case "repo_replaced": return t("projects.claim.repo_replaced", { repo });
      case "not_found": return t("projects.claim.not_found");
      case "no_github_repo": return t("projects.claim.no_github_repo");
      default: return t("projects.claim.github_unavailable");
    }
  }

  async function claim(body: { productIds: number[] } | { repoUrl: string }, mark: string) {
    if (pending) return;
    setPending(mark);
    setNotices([]);
    const result = await makerRequest<{ results: ClaimItem[] }>("/api/maker/claims", "POST", csrfToken, body);
    setPending(null);
    if (!result.ok) {
      setNotices([{ key: "error", text: t(makerErrorKey(result.code)), ok: false }]);
      return;
    }
    setNotices(result.data.results.map((item) => ({ key: `${item.productId}`, text: claimText(item), ok: item.result === "verified" || item.result === "already_verified" })));
    if (result.data.results.some((item) => item.result === "verified")) {
      setAddress("");
      router.refresh();
    }
  }

  if (!linked) {
    return (
      <section className="me-proj-box is-dashed">
        <div className="me-proj-box-h"><span className="me-proj-logo" aria-hidden>gh</span><div className="me-proj-box-x"><h2>{t("projects.found.title")}</h2><p>{t("projects.found.noGithub")}</p></div></div>
      </section>
    );
  }

  const body = !login ? t("projects.found.noLogin")
    : repos.length > 0 ? t("projects.found.body", { login, count: repos.length }) : t("projects.found.none", { login });
  return (
    <section className="me-proj-box is-dashed" aria-busy={pending !== null}>
      <div className="me-proj-box-h">
        <span className="me-proj-logo" aria-hidden>gh</span>
        <div className="me-proj-box-x"><h2>{t("projects.found.title")}</h2><p>{body}</p></div>
        {repos.length > 1 && (
          <button type="button" className="me-proj-btn is-primary" disabled={pending !== null}
            onClick={() => {
              trackEvents(repos.slice(0, 20).map((repo) => ({ name: "claim_start", params: { product_slug: repo.slug, step: "claim" } })));
              void claim({ productIds: repos.slice(0, 20).map((repo) => repo.productId) }, "all");
            }}>{t("projects.found.all")}</button>
        )}
      </div>
      {repos.length > 0 && (
        <ul className="me-proj-found">
          {repos.map((repo) => (
            <li key={repo.productId}>
              <div className="me-proj-box-x">
                <span className="me-proj-mono">{repo.repo}</span>
                <span className="me-proj-sub">{repo.tagline} · {t("projects.found.listed", { date: formatDate(repo.listedAt, now, locale) })}</span>
              </div>
              <button type="button" className="me-proj-btn" disabled={pending !== null} onClick={() => claim({ productIds: [repo.productId] }, `one:${repo.productId}`)}
                {...trackAttrs("claim_start", { product_slug: repo.slug, step: "claim" })}>
                {t("projects.found.one")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="me-proj-find" onSubmit={(event) => { event.preventDefault(); if (address.trim()) void claim({ repoUrl: address.trim() }, "address"); }}>
        <label htmlFor="me-proj-find-input">{t("projects.found.addressLabel")}</label>
        <input id="me-proj-find-input" className="me-proj-input" value={address} onChange={(event) => setAddress(event.target.value)} maxLength={300}
          placeholder={t("projects.found.addressPlaceholder")} autoComplete="off" spellCheck={false} inputMode="url" />
        <button type="submit" className="me-proj-btn" disabled={pending !== null || !address.trim()}>{t("projects.found.addressSubmit")}</button>
      </form>
      <p className="me-proj-hint">{t("projects.found.hint")}</p>
      <div role="status" aria-live="polite" className="me-proj-notices">
        {pending !== null && <p className="me-proj-hint">{t("projects.found.checking")}</p>}
        {notices.map((notice) => <p key={notice.key} className={notice.ok ? "me-proj-notice is-ok" : "me-proj-notice is-bad"}>{notice.text}</p>)}
      </div>
    </section>
  );
}
