"use client";

import { useEffect, useId, useRef } from "react";
import { useTranslations } from "@/lib/i18n/context";
import { Icon } from "@/components/home/icons";
import type { LicensePresentation, LicenseValue } from "@/lib/domain/products/detail-view";
import { safeExternalUrl } from "./format";
import { GITHUB_LICENSE_GUIDE_URL, LICENSE_GUIDE } from "./license-guide";

function LicenseSource({ value, observed }: { value: LicenseValue; observed: boolean }) {
  const t = useTranslations("detail");
  const spdx = value.spdxId?.trim();
  const identified = Boolean(spdx && spdx !== "NOASSERTION" && spdx !== "NONE");
  const url = safeExternalUrl(value.url);
  const github = observed && value.sourceLabel.includes("GitHub");

  return (
    <div className="min-w-0 rounded-[10px] border border-line p-3">
      <p className="m-0 text-[13px] text-fg-2">{github ? t("license.githubSource") : t("source.maker")}</p>
      <p className="m-0 mt-1 break-words font-semibold">{identified ? spdx : value.value}</p>
      {!identified && <p className="m-0 mt-1 text-[13px] text-fg-2">{t("license.unidentified")}</p>}
      {url && <p className="m-0 mt-2 text-[13px]"><a href={url} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline underline-offset-2">{t("license.provided")} ↗</a></p>}
    </div>
  );
}

export function LicenseDialog({ license, source, repositoryUrl, label }: {
  license: LicensePresentation;
  source: { state: string; lastSuccess: string; lastFailure: string } | null;
  repositoryUrl: string | null;
  label: string;
}) {
  const t = useTranslations("detail");
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreScroll = useRef<(() => void) | null>(null);
  const id = useId();
  const unidentifiedLicense = license.state === "unidentified";
  const sourceStatus = source?.state === "disconnected" ? t("license.disconnected")
    : source?.state === "failed" ? t("license.failed")
      : source?.state === "stale" ? t("license.stale")
        : source?.state === "unobserved" ? t("license.unobserved") : t("license.observed");

  useEffect(() => () => { restoreScroll.current?.(); }, []);

  function unlockScroll() {
    const restore = restoreScroll.current;
    restoreScroll.current = null;
    restore?.();
  }

  function open() {
    const node = dialog.current;
    if (!node || node.open) return;
    node.showModal();
    if (restoreScroll.current) return;
    const restorers = [document.documentElement.style, document.body.style].map((style) => {
      const previous = ["overflow-x", "overflow-y"].map((property) => ({
        property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property),
      }));
      for (const { property } of previous) style.setProperty(property, "hidden", "important");
      return () => {
        for (const { property, value, priority } of previous) style.setProperty(property, value, priority);
      };
    });
    restoreScroll.current = () => { for (const restore of restorers) restore(); };
  }

  function close() {
    dialog.current?.close();
    unlockScroll();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-controls={id}
        aria-label={t("license.open", { label })}
        onClick={open}
        className="max-w-full cursor-pointer truncate rounded-sm text-left underline decoration-line underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-ink"
      >
        {label}<span aria-hidden className="ml-1 text-[13px] font-normal text-fg-2">ⓘ</span>
      </button>
      <dialog
        ref={dialog}
        id={id}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-summary`}
        onClose={(event) => {
          if (event.currentTarget.open) return;
          unlockScroll();
          trigger.current?.focus({ preventScroll: true });
        }}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        className="whitespace-normal text-[14px] font-normal leading-relaxed tracking-normal"
        style={{ margin: "auto", width: "min(960px, calc(100vw - 24px))", maxWidth: "calc(100vw - 24px)", maxHeight: "calc(100dvh - 24px)", overflow: "hidden", padding: 0 }}
      >
        <div className="flex max-h-[calc(100dvh-26px)] flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 id={`${id}-title`} className="m-0 text-[18px] font-semibold">{t("license.title")}</h2>
            <button type="button" onClick={close} aria-label={t("action.close")} className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[10px] bg-bg-soft text-fg-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink"><Icon name="close" /></button>
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain p-4">
            <p id={`${id}-summary`} className="m-0 text-[13px] text-fg-2">{t("license.summary")}</p>
            <h3 className="mb-2 mt-5 text-[15px] font-semibold">{t("license.shown")}</h3>
            {license.state === "conflict" && <p className="mb-3 mt-0 text-[13px] text-down">{t("license.conflict")}</p>}
            {license.state === "maker_only" && <p className="mb-3 mt-0 text-[13px] text-fg-2">{t("license.makerOnly")}</p>}
            {unidentifiedLicense && <p className="mb-3 mt-0 text-[13px] text-fg-2">{t("license.unknown")}</p>}
            {license.state === "missing" && <p className="mb-3 mt-0 text-[13px] text-fg-2">{t("license.missing")}</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              {license.observed && <LicenseSource value={license.observed} observed />}
              {license.maker && <LicenseSource value={license.maker} observed={false} />}
            </div>
            {license.observed && <p className="mb-0 mt-2 text-[13px] text-fg-2">{t("license.observationLimit")}</p>}
            {license.observed && source && <p className="mb-0 mt-2 text-[13px] text-fg-2">{sourceStatus}{source.lastSuccess && ` · ${t("license.lastSuccess", { date: source.lastSuccess })}`}{source.lastFailure && ` · ${t("license.lastFailure", { date: source.lastFailure })}`} {t("license.kst")}</p>}
            {repositoryUrl && <p className="mb-0 mt-2 text-[13px]"><a href={repositoryUrl} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline underline-offset-2">{t("license.repository")} ↗</a></p>}
            <h3 id={`${id}-table-title`} className="mb-2 mt-6 text-[15px] font-semibold">{t("license.compare")}</h3>
            <p className="mb-3 mt-0 text-[13px] text-fg-2">{t("license.tableNote")}</p>
            <div role="region" aria-labelledby={`${id}-table-title`} tabIndex={0} className="overflow-x-auto rounded-[10px] border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink">
              <table className="w-full min-w-[780px] border-collapse text-left text-[13px]">
                <caption className="sr-only">{t("license.caption")}</caption>
                <thead className="bg-bg-soft">
                  <tr>
                    {(["license.column.name", "license.column.commercial", "license.column.redistribution", "license.column.source", "license.column.conditions"] as const).map((title) => <th key={title} scope="col" className="border-b border-line px-3 py-2 font-semibold">{t(title)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {LICENSE_GUIDE.map((row) => (
                    <tr key={row.name} className="border-b border-line last:border-b-0">
                      <th scope="row" className="whitespace-nowrap px-3 py-3 align-top font-medium"><a href={row.url} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline underline-offset-2">{row.name} ↗</a></th>
                      <td className="whitespace-nowrap px-3 py-3 align-top">{t(row.commercial)}</td>
                      <td className="px-3 py-3 align-top">{t(row.redistribution)}</td>
                      <td className="min-w-[180px] px-3 py-3 align-top">{t(row.source)}</td>
                      <td className="min-w-[240px] px-3 py-3 align-top">{t(row.conditions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mb-0 mt-3 text-[13px] text-fg-2">{t("license.suffixNote")}</p>
            <p className="mb-0 mt-3 text-[13px]"><a href={GITHUB_LICENSE_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline underline-offset-2">{t("license.githubGuide")} ↗</a></p>
          </div>
        </div>
      </dialog>
    </>
  );
}
