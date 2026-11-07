import type { ReactNode } from "react";
import { LLM_OPS_LEVELS, type LlmOpsLevel } from "@/lib/operations/llm-ops-view";

/** 상태 단계를 한 낱말로(배지 글자) — 범례(LLM_OPS_LEVELS.label)보다 짧다. */
export const LEVEL_WORD: Readonly<Record<LlmOpsLevel, string>> = { ok: "정상", warn: "주의", bad: "멈춤·실패", idle: "의도적 중지", unknown: "확인 불가" };

/** 상태 하나 — 색(data-level)·모양(●▲■‖?)·글자를 늘 함께 쓴다. 모양은 낭독기가 읽지 않는다(글자가 뜻을 다 전한다). */
export function LevelBadge({ level, children, title }: { level: LlmOpsLevel; children: ReactNode; title?: string }) {
  return <span className="llm-level" data-level={level} title={title}><span className="llm-level-shape" aria-hidden="true">{LLM_OPS_LEVELS[level].shape}</span>{children}</span>;
}

export function LevelLegend() {
  return <p className="llm-legend" aria-label="상태 표시 범례">{(["ok", "warn", "bad", "idle", "unknown"] as const).map(level =>
    <LevelBadge key={level} level={level}>{LLM_OPS_LEVELS[level].label}</LevelBadge>)}
    <span className="llm-legend-note">색과 모양, 글자를 함께 씁니다.</span></p>;
}

/** 관측 시각(KST). 못 읽었으면 그렇게 적는다. */
export function ObservedAt({ label, at }: { label: string; at: string | null }) {
  const text = at ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at)) : null;
  return <span className={`llm-stamp${text ? "" : " stale"}`}>{label} {text ? `${text} KST` : "읽지 못함"}</span>;
}
