"use client";

import { useRef, useState } from "react";

type CopyResult = "copied" | "selected" | "failed";

/**
 * 클립보드에 넣고, 못 넣으면(권한 거부·클립보드 없는 브라우저) 명령 글자를 선택해 둔다 — 사람이 ⌘C 로 복사하게.
 * 선택은 명령 글자만 감싼 노드에 건다. 앞의 '$' 는 함께 복사되면 붙여넣은 명령이 깨진다.
 */
export async function copyOrSelect(text: string, target: Node | null): Promise<CopyResult> {
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!target || !selection) return "failed";
    selection.selectAllChildren(target);
    return "selected";
  }
}

const STATUS: Record<CopyResult | "idle", string> = {
  idle: "",
  copied: "복사했습니다.",
  selected: "자동 복사가 안 됩니다. 선택된 명령을 복사해 주세요(⌘C 또는 Ctrl+C).",
  failed: "자동 복사가 안 됩니다. 명령을 직접 선택해 복사해 주세요.",
};

/**
 * 복사 단추가 붙은 명령 한 줄(2026-10-08 UX 감사 UX-20).
 * 명령은 꺾지 않고 한 줄로 둔다 — 좁은 화면에서는 줄 안에서 가로로 밀린다. 출력 예시와 섞이지 않게 테두리 칸에 담는다.
 * 색은 토큰이라 .surface-dark(터미널) 안에서는 어둡게, 밖에서는 화면 테마대로 그려진다.
 */
export function CopyCommand({ command, label, prompt }: {
  command: string;
  /** 단추가 읽히는 이름 — "설치 명령 복사" */
  label: string;
  /** 명령 앞 표시('$') — 복사되지 않는다 */
  prompt?: string;
}) {
  const commandRef = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<CopyResult | "idle">("idle");

  async function copy() {
    const result = await copyOrSelect(command, commandRef.current);
    setState(result);
    if (result === "copied") window.setTimeout(() => setState("idle"), 2_000);
  }

  return (
    <div>
      <div className="flex items-center gap-2 rounded-[10px] border border-line bg-bg-soft pl-4 pr-1">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-3 font-mono text-[13px] font-bold text-fg">
          {prompt && <span aria-hidden="true" className="mr-2 select-none font-normal text-fg-2">{prompt}</span>}
          <span ref={commandRef}>{command}</span>
        </code>
        <button type="button" onClick={copy} aria-label={`${label} 복사`}
          className="inline-flex min-h-11 shrink-0 items-center rounded-[8px] px-3 text-[13px] font-medium text-fg hover:bg-line">
          {state === "copied" ? "복사됨 ✓" : "복사"}
        </button>
      </div>
      <p role="status" className={state === "selected" || state === "failed" ? "mt-1.5 text-[13px] text-fg-2" : "sr-only"}>
        {STATUS[state]}
      </p>
    </div>
  );
}
