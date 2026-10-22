"use client";

import { useTranslations } from "@/lib/i18n/context";
import { useId, useState } from "react";
import { installationPrompt } from "@/lib/domain/products/access";
import { trackAttrs } from "@/lib/analytics/attrs";

export function InstallPrompt({ repoUrl, slug }: { repoUrl: string; slug?: string }) {
  const t = useTranslations("detail");
  const prompt = installationPrompt(repoUrl) ? t("install.prompt", { url: repoUrl }) : null;
  const id = useId();
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  if (!prompt) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt!);
      setCopied(true);
      setManual(false);
    } catch {
      setCopied(false);
      setManual(true);
    }
  }

  // 히어로 단추 줄에 그대로 끼어든다(contents) — 복사 단추는 제자리, 안내 문장과 직접 복사 칸은 줄 끝으로
  return (
    <div className="contents">
      <button type="button" onClick={copy}
        {...(slug ? trackAttrs("copy_text", { copy_target: "install_prompt", product_slug: slug }) : {})}
        className="inline-flex min-h-11 items-center rounded-full bg-bg-soft px-5 text-[15px] font-medium text-fg">
        {copied ? t("install.copied") : t("install.copy")}
      </button>
      <p className="order-last text-[13px] leading-6 text-fg-2">{t("install.note")}</p>
      <span role="status" className="sr-only">{copied ? t("install.copyStatus") : manual ? t("install.manualStatus") : ""}</span>
      <details open={manual || undefined} className="order-last basis-full text-[13px] text-fg-2">
        <summary className="cursor-pointer">{manual ? t("install.manual") : t("install.view")}</summary>
        <label className="sr-only" htmlFor={id}>{t("install.label")}</label>
        <textarea id={id} readOnly value={prompt} onFocus={event => event.currentTarget.select()} rows={9}
          className="mt-2 w-full rounded-lg border border-line bg-bg-soft p-3 text-[13px] text-fg-2" />
      </details>
    </div>
  );
}
