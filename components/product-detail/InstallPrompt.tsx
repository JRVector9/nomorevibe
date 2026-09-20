"use client";

import { useId, useState } from "react";
import { installationPrompt } from "@/lib/domain/products/access";

export function InstallPrompt({ repoUrl }: { repoUrl: string }) {
  const prompt = installationPrompt(repoUrl);
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

  return (
    <div className="w-full">
      <button type="button" onClick={copy}
        className="inline-flex min-h-11 items-center justify-center rounded-[10px] bg-accent-solid px-5 text-[13px] font-extrabold text-white hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        {copied ? "프롬프트 복사됨 ✓" : "Copy Prompt · 설치 도움받기"}
      </button>
      <p className="mt-2 text-[13px] leading-6 text-fg-3">Claude·ChatGPT에 붙여넣으면 내 환경에 맞는 설치 방법을 안내받을 수 있습니다.</p>
      <span role="status" className="sr-only">{copied ? "설치 프롬프트가 복사되었습니다." : manual ? "자동 복사가 지원되지 않습니다. 아래 프롬프트를 선택해 복사해주세요." : ""}</span>
      <details open={manual || undefined} className="mt-2 text-[13px] text-fg-3">
        <summary className="cursor-pointer">{manual ? "직접 선택해 복사하기" : "프롬프트 내용 보기"}</summary>
        <label className="sr-only" htmlFor={id}>설치 프롬프트</label>
        <textarea id={id} readOnly value={prompt} onFocus={event => event.currentTarget.select()} rows={9}
          className="mt-2 w-full rounded-lg border border-line bg-bg-soft p-3 text-[13px] text-fg-2" />
      </details>
    </div>
  );
}
