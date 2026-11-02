"use client";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { kstClock } from "@/lib/operations/admin-models-view";
import { buttonSmall } from "../settings/Switch";

export const REFRESH_PERIOD_MS = 30_000;

/**
 * 고정 상단 띠(2026-10-31 승인 시안) — 제목·하위 화면 링크·「마지막 갱신 HH:MM:SS(서버 렌더 시각) · 30초마다 자동 · 진행 막대 · 다음 N초 · 멈춤 표시 · 수동 새로고침」.
 * 옛 LiveModels 의 30초 타이머(숨김 탭·열린 dialog 때 건너뛰기)를 그대로 옮기고 카운트다운을 더했다 — 멈춘 동안은 초를 세지 않고 「멈춤」을 보인다.
 * 다시 읽기는 router.refresh() 라 입력·스크롤은 그대로다. 관리자 틀의 LiveBar(15초)는 별개로 돈다.
 */
export function RefreshBar({ renderedAt, periodMs = REFRESH_PERIOD_MS }: { renderedAt: string; periodMs?: number }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const period = Math.max(1, Math.round(periodMs / 1000));
  const [paused, setPaused] = useState<string | null>(null);
  // 서버가 새로 그리면(renderedAt 바뀜) 카운트다운을 처음부터 — 그리는 중에 되돌리는 파생 상태(effect 안 setState 아님)
  const [count, setCount] = useState({ at: renderedAt, left: period });
  if (count.at !== renderedAt) setCount({ at: renderedAt, left: period });
  useEffect(() => {
    const tick = () => {
      const blocked = document.hidden ? "숨김 탭" : document.querySelector("dialog[open]") ? "열린 대화상자" : null;
      setPaused(blocked);
      if (blocked) return;
      setCount(prev => ({ at: prev.at, left: prev.left <= 0 ? period : prev.left - 1 }));
    };
    const timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [period]);
  // 0 에 닿으면 다시 읽는다 — 서버가 새 renderedAt 을 주면 위에서 되돌아가고, 못 주면 다음 틱이 period 로 되돌려 30초 뒤 다시 시도한다
  useEffect(() => { if (count.left === 0) startRefresh(() => router.refresh()); }, [count.left, router]);
  const left = count.left;
  const manual = () => { setCount({ at: renderedAt, left: period }); startRefresh(() => router.refresh()); };
  return <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] md:ml-auto" role="status" aria-live="off">
    <span>마지막 갱신 <time dateTime={renderedAt} className="font-mono font-semibold tabular-nums">{kstClock(renderedAt)}</time><span className="text-fg-2"> KST</span></span>
    <span className="text-fg-2">{period}초마다 자동</span>
    <span className="relative h-1.5 w-[120px] overflow-hidden rounded-[3px] bg-bg-soft max-sm:w-[72px]" aria-hidden="true">
      <i className="absolute inset-y-0 left-0 block w-full origin-left bg-accent transition-transform duration-1000 ease-linear" style={{ transform: `scaleX(${paused ? left / period : Math.max(0, left) / period})` }} /></span>
    <span className="font-mono tabular-nums text-fg-2">{refreshing ? "갱신 중…" : paused ? `멈춤 · 다음 ${left}초` : `다음 ${left}초`}</span>
    {paused && <span className="font-semibold text-warn">{paused} → 멈춤</span>}
    <button type="button" className={buttonSmall} onClick={manual} aria-disabled={refreshing || undefined}>수동 새로고침</button>
  </div>;
}

/** 상단 띠 전체 — 제목과 화면 안 링크(배정·장비 한도·계약·등록부)를 왼쪽에, 갱신 상태를 오른쪽에. 데스크톱에서는 붙어 따라오고(sticky), 폰에서는 메뉴 머리와 겹치지 않게 흐른다(models.css). */
export function ModelsTopBar({ renderedAt }: { renderedAt: string }) {
  return <header className="models-topbar z-[5] -mx-8 border-b border-line bg-bg-card px-8 py-2 max-sm:-mx-4 max-sm:px-4 md:sticky md:top-0">
    <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h1 className="text-[18px] font-bold">모델 운영 현황</h1>
        <span className="text-[13px] text-fg-2">/admin/models · <a href="#assign" className="underline underline-offset-[3px]">배정</a> · <a href="#devices" className="underline underline-offset-[3px]">장비 한도</a> · <a href="#ref" className="underline underline-offset-[3px]">계약·등록부</a>
          {" · "}<Link href="/admin/models/devices" prefetch={false} className="underline underline-offset-[3px]">장비 설정 →</Link>
          {" · "}<Link href="/admin/models/helpers" prefetch={false} className="underline underline-offset-[3px]">도우미 →</Link>
          {" · "}<Link href="/admin/models/contracts" prefetch={false} className="underline underline-offset-[3px]">모델 연결 →</Link>
          {" · "}<Link href="/admin/models/limits" prefetch={false} className="underline underline-offset-[3px]">실시간 한도 →</Link>
          {" · "}<Link href="/admin/models/assignments" prefetch={false} className="underline underline-offset-[3px]">모델 배정 →</Link>
          {" · "}<Link href="/admin/models/tasks" prefetch={false} className="underline underline-offset-[3px]">작업 ↔ 모델 →</Link>
          {" · "}<Link href="/admin/status" prefetch={false} className="underline underline-offset-[3px]">운영센터 →</Link></span>
      </div>
      <RefreshBar renderedAt={renderedAt} />
    </div>
  </header>;
}
