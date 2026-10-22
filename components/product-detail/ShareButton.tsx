"use client";

import { useTranslations } from "@/lib/i18n/context";
import { useState } from "react";
import { track } from "@/lib/analytics/client";

/**
 * 공유 — 기기 공유 창(navigator.share)이 있으면 그것으로, 없으면 주소를 복사한다(UX-31).
 * 바깥 링크 화살표(↗)와 헷갈리지 않게 공유 아이콘에 '공유' 글자를 붙인다.
 * 방문 분석: 실제로 공유했을 때만 share(method native·copy_link). 공유 창을 닫았거나 복사에 실패하면 보내지 않는다.
 */
export function ShareButton({ title, path, slug }: { title: string; path: string; slug?: string }) {
  const t = useTranslations("detail");
  const [note, setNote] = useState<string | null>(null);

  function flash(message: string) {
    setNote(message);
    window.setTimeout(() => setNote(null), 1_500);
  }

  async function share() {
    const url = new URL(path, window.location.origin).toString();
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        if (slug) track("share", { method: "native", content_type: "product", item_id: slug });
        return;
      } catch (error) {
        // 공유 창을 닫은 것은 실패가 아니다 — 복사로 넘어가지 않는다
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      if (slug) track("share", { method: "copy_link", content_type: "product", item_id: slug });
      flash(t("share.copied"));
    } catch {
      flash(t("share.failed"));
    }
  }

  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => void share()}
        className="inline-flex h-11 items-center gap-1.5 rounded-full bg-bg-soft px-3.5 text-[14px] font-medium text-fg sm:px-4 sm:text-[15px]"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 15V3m-4 4 4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
        </svg>
        {t("share.title")}
      </button>
      {/* 단추 글자는 그대로 두고 — 줄이 흔들리지 않게 — 복사했다는 말은 단추 아래에 잠깐 띄운다 */}
      <span
        role="status"
        className={note
          ? "absolute left-1/2 top-full z-10 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-full border border-line bg-bg-card px-2.5 py-1 text-[13px] text-fg"
          : "sr-only"}
      >
        {note ?? ""}
      </span>
    </span>
  );
}
