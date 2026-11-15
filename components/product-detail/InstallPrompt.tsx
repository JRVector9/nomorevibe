"use client";

import { useTranslations } from "@/lib/i18n/context";
import { useId, useState } from "react";
import { trackAttrs } from "@/lib/analytics/attrs";

/**
 * 설치 안내 복사 — 복사할 글(prompt)은 서버가 만든다(installPromptText). 저장소 주소를 따로 속성으로 받지 않아
 * 브라우저 부품 속성에 repoUrl 칸이 실리지 않는다(2026-11-15 공개 HTML 줄이기 2차). 주소는 복사할 글 안에만 있다.
 */
export function InstallPrompt({ prompt, slug }: { prompt: string | null; slug?: string }) {
  const t = useTranslations("detail");
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
