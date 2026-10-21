"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { clearSavedNotice, mergeBrowserSaved, postponeMerge, type SavedNotice } from "@/components/home/saved";
import { useSavedAccount } from "@/components/home/useSavedSlugs";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { stripLocale } from "@/lib/i18n/routing";
import { ME_TAB_PATHS, SAVED_LIMIT } from "@/lib/me/contract";
import "./saved-sync.css";

/** 저장 동기화가 알릴 말 — 옮긴 수·건너뛴 수·실패·상한·목록에 없는 제품 */
export function savedNoticeText(notice: SavedNotice, t: Translator<"common">, locale: Locale): string {
  if (notice.kind === "limit") return t("saved.limit", { limit: formatNumber(SAVED_LIMIT, locale) });
  if (notice.kind === "mergeFailed") return t("saved.mergeFailed");
  if (notice.kind === "unavailable") return t("saved.unavailable");
  const merged = t("saved.merged", { count: formatNumber(notice.merged, locale) });
  return notice.skipped > 0 ? `${merged} ${t("saved.mergeSkipped", { count: formatNumber(notice.skipped, locale) })}` : merged;
}

/** 첫 로그인 합치기 묻기(L4) — «옮기기»·«나중에». 저장 탭과 토스트가 같이 쓴다 */
export function SavedMergePrompt({ count, className, onMerged }: { count: number; className?: string; onMerged?: () => void }) {
  const t = useTranslations("common");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  async function move() {
    setBusy(true);
    const merged = await mergeBrowserSaved();
    setBusy(false);
    if (merged) onMerged?.();
  }
  return (
    <div className={`saved-merge${className ? ` ${className}` : ""}`}>
      <p>{t("saved.mergePrompt", { count: formatNumber(count, locale) })}</p>
      <div className="saved-merge-actions">
        <button type="button" className="saved-merge-move" onClick={move} disabled={busy}>{t(busy ? "saved.merging" : "saved.mergeMove")}</button>
        <button type="button" className="saved-merge-later" onClick={postponeMerge} disabled={busy}>{t("saved.mergeLater")}</button>
      </div>
    </div>
  );
}

/**
 * 어느 화면에서나 뜨는 저장 토스트 — 로그인 뒤 이 브라우저에만 있는 저장을 옮길지 한 번 묻고, 옮긴 결과·상한을 알린다.
 * 저장 탭(/me)은 제 자리에서 묻고 알린다.
 */
export function SavedToast() {
  const t = useTranslations("common");
  const locale = useLocale();
  const account = useSavedAccount();
  const pathname = stripLocale(usePathname()).replace(/\/$/, "") || "/";
  useEffect(() => {
    if (!account.notice) return;
    const timer = setTimeout(clearSavedNotice, 6_000);
    return () => clearTimeout(timer);
  }, [account.notice]);
  if (pathname === ME_TAB_PATHS.saved) return null;
  const offer = account.status === "user" && account.offer > 0;
  if (!offer && !account.notice) return null;
  return (
    <div className="saved-toast" role="status">
      {account.notice ? (
        <div className="saved-toast-row">
          <p>{savedNoticeText(account.notice, t, locale)}</p>
          <button type="button" className="saved-toast-close" onClick={clearSavedNotice}>{t("saved.close")}</button>
        </div>
      ) : <SavedMergePrompt count={account.offer} />}
    </div>
  );
}
