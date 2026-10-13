import { publicUserAuthEnabled, githubStarEnabled, productFeedbackEnabled, githubFeedbackDeliveryEnabled } from "@/lib/domain/github-integration/flags";
import { formatListTime } from "@/lib/format/time";
import type { CollectorQuotaStatus } from "./status-summary";

const DOCS = "https://github.com/JRVector9/nomorevibe/blob/main/";

export function OperationsGuidance({ quota, now }: { quota: CollectorQuotaStatus; now: string }) {
  const flags = [["사용자 로그인", publicUserAuthEnabled()], ["GitHub 스타", githubStarEnabled()],
    ["제품 피드백", productFeedbackEnabled()], ["GitHub 전송", githubFeedbackDeliveryEnabled()]] as const;
  return <section className="ops-panel">
    <h2>관측 범위와 외부 운영</h2>
    <p>이 화면은 DB에 저장된 관측을 읽습니다. 릴리스 문자열은 RELEASE_TAG이며 실제 소스·이미지 digest·배포 완료의 증거는 별도 운영 기록에서 확인합니다.</p>
    <p className="mt-2 text-[13px] text-fg-2">이 웹 프로세스의 배포 설정: {flags.map(([name, enabled]) => `${name} ${enabled ? "켜짐" : "꺼짐"}`).join(" · ")}. 다른 웹·역할의 적용 여부는 별도로 확인합니다.</p>
    <details className="mt-3">
      <summary>GitHub 수집 자격의 저장된 core 관측</summary>
      {quota.readFailed && <p>일부 자격 목록을 읽지 못했습니다.</p>}
      {quota.sources.length === 0 ? <p>관리자에 등록된 활성 자격의 관측이 없습니다.</p> : <ul className="mt-2 space-y-1 text-[13px]">
        {quota.sources.map((row) => <li key={row.label}>{row.label} · {row.stale ? "오래됨·미확인" : "최신 관측"} · {row.quota ? `${row.quota.remaining.toLocaleString("ko-KR")}/${row.quota.limit.toLocaleString("ko-KR")} 남음 · ${formatListTime(row.quota.reset * 1000, now)} 초기화` : "잔량 미확인"} · 관측 {formatListTime(row.observedAt, now, "없음")}</li>)}
      </ul>}
      <p className="mt-2 text-[13px] text-fg-3">1시간이 지났거나 reset이 지난 값은 미확인입니다. 환경 토큰·인증 실패·search·GraphQL·공유 대기는 이 core 집계에 포함하지 않습니다. API 사용량은 제품 저장량과 다릅니다.</p>
    </details>
    <details className="mt-3">
      <summary>저장 진행·중단·알림의 판단 범위</summary>
      <p className="mt-2 text-[13px] text-fg-2">화면과 기존 monitor의 저장 진행 판정은 수집·규칙·1차·2차·발행 5단계입니다. 역할 자체 복구의 maintenance 판정은 서비스 응답 점검, text 판정은 사유 번역·소개 생성·검색 키워드 생성/검수입니다. 유효한 실행 중 작업은 자체 복구의 정체 판정에서 제외합니다. 공개 제품 다국어 번역은 별도 ledger로 확인합니다.</p>
      <p className="mt-2 text-[13px] text-fg-2">수집 스위치는 탐색·원본 수집·규칙/AI/2차 심사·소개 생성·분류/발행·발행분 감사를 멈춥니다. 서비스 점검·스타 관측·기존 제품 갱신 등 다른 자동 작업은 계속됩니다. 실행 중 호출을 강제 취소하지 않습니다. 사람이 중단한 소개 검수는 계속 중단 상태입니다.</p>
      <p className="mt-2 text-[13px] text-fg-2">monitor 코드나 현재 화면의 정상 판정은 실제 경보 수신·회복·외부 deadman 검증을 뜻하지 않습니다. 백업·복원과 장기 관측도 실제 검증 기록을 확인합니다.</p>
    </details>
    <p className="mt-3 flex flex-wrap gap-4 text-[13px]">
      <a className="underline" href={`${DOCS}docs/operations/independent-workers-runbook.md`} target="_blank" rel="noopener noreferrer">역할 복귀·배포·감시 runbook</a>
      <a className="underline" href={`${DOCS}PENDING.md`} target="_blank" rel="noopener noreferrer">남은 운영 검증·복원 증거</a>
    </p>
  </section>;
}
