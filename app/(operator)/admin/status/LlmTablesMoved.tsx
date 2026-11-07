import Link from "next/link";

/**
 * 진단 탭에 있던 LLM 표 두 개(text 작업 순위·모델 경로 계약)는 LLM 운영 › 고급 설정의 「장애 분석」으로 옮겼다(2026-11-07 PR 5).
 * 운영센터에는 그리로 가는 링크 한 줄만 남긴다.
 */
export function LlmTablesMoved() {
  return <p className="text-[13px] text-fg-2">
    <Link href="/admin/models/advanced#llm-routes" prefetch={false} className="font-semibold text-accent-ink">LLM 작업 순위·경로 계약은 LLM 운영 › 고급 설정으로 옮겼습니다 →</Link>
  </p>;
}
