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

  // 히어로 단추 줄에 그대로 끼어든다(contents) — 복사 단추는 제자리, 안내 문장과 직접 복사 칸은 줄 끝으로
  return (
    <div className="contents">
      <button type="button" onClick={copy}
        className="inline-flex min-h-11 items-center rounded-full bg-bg-soft px-5 text-[15px] font-medium text-fg">
        {copied ? "복사됨 ✓" : "설치 프롬프트 복사"}
      </button>
      <p className="order-last text-[13px] leading-6 text-fg-2">Claude·ChatGPT에 붙여넣으면 내 환경에 맞는 설치 방법을 안내받을 수 있습니다.</p>
      <span role="status" className="sr-only">{copied ? "설치 프롬프트가 복사되었습니다." : manual ? "자동 복사가 지원되지 않습니다. 아래 프롬프트를 선택해 복사해주세요." : ""}</span>
      <details open={manual || undefined} className="order-last basis-full text-[13px] text-fg-2">
        <summary className="cursor-pointer">{manual ? "직접 선택해 복사하기" : "프롬프트 내용 보기"}</summary>
        <label className="sr-only" htmlFor={id}>설치 프롬프트</label>
        <textarea id={id} readOnly value={prompt} onFocus={event => event.currentTarget.select()} rows={9}
          className="mt-2 w-full rounded-lg border border-line bg-bg-soft p-3 text-[13px] text-fg-2" />
      </details>
    </div>
  );
}
