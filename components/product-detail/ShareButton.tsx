"use client";

import { useState } from "react";
import { Icon } from "@/components/home/icons";

export function ShareButton({ title, path }: { title: string; path: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = new URL(path, window.location.origin).toString();
    if (navigator.share) {
      await navigator.share({ title, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => void share()}
        aria-label="공유"
        className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-bg-soft text-fg"
      >
        <Icon name="arrow-up-right" size={18} />
      </button>
      {/* 아이콘 단추라 글자를 바꿀 수 없다 — 링크를 복사했다는 말은 단추 아래에 잠깐 띄운다 */}
      <span
        role="status"
        className={copied
          ? "absolute left-1/2 top-full z-10 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-full border border-line bg-bg-card px-2.5 py-1 text-[13px] text-fg"
          : "sr-only"}
      >
        {copied ? "링크 복사됨" : ""}
      </span>
    </span>
  );
}
