import Link from "next/link";
import type { AdminModelsObservation } from "@/lib/operations/admin-models-observation";
import { elapsedModelTime, modelStageLabel } from "@/lib/operations/admin-models-view";
import { clock, DataTable, Facts, Panel, ReadStamp, Tag } from "../flow/PrototypeParts";

const stateText = { waiting: "용량 대기", reserved: "슬롯 예약", dispatched: "전송 실행 중", indeterminate: "결과 미확정" };
/** 결과 미확정 요청의 근거·조치(다시 대기열·닫기)는 지금 고급 설정의 사람 검토 목록에 있다. */
export const MODEL_REQUEST_REVIEW_HREF = "/admin/models?advanced=1#review";

/** 열린 호출(대기·예약·전송·미확정) 표 — 예전 실시간·조치 기록 탭이 같은 표를 두 번 그렸다. 이제 「기록」 한 곳이다. */
export function ModelCallsPanel({ observation, limit = 12 }: { observation: AdminModelsObservation; limit?: number }) {
  const unavailable = !!observation.error || !observation.observedAt;
  return <Panel title="호출 기록 · 업무 결과 대조" tool={<ReadStamp at={observation.observedAt} />}><DataTable heads={["호출", "작업·모델", "호출 상태", "대기 포함 시간", "업무 반영", "근거"]} note={`열린 요청 ${observation.truncated ? "상위 100건 중 " : ""}${Math.min(limit, observation.requests.length)}건 표시. 모델 응답과 판정·번역·공개 반영의 원본은 각각 대조합니다.`}>
    {observation.requests.slice(0, limit).map(request => <tr key={request.requestId}><td><code>{request.requestId.slice(0, 8)}</code></td><td><b>{modelStageLabel(request.routeId)}</b><p>{request.model}</p></td><td><Tag tone={request.state === "indeterminate" ? "red" : request.state === "waiting" ? "amber" : "blue"}>{stateText[request.state]}</Tag></td><td className="mono">{elapsedModelTime(request.queuedAt, observation.observedAt)}</td><td>{request.localEndRecorded ? "로컬 호출 종료 기록 있음" : "업무 반영 별도 확인"}<p>도메인 저장·공개 완료를 뜻하지 않음</p></td><td><details><summary className="text-button">대조</summary><Facts rows={[["요청", request.requestId], ["소유 프로세스", request.ownerInstanceId], ["장비 그룹", request.groupId], ["접수", clock(request.queuedAt)], ["전송", clock(request.dispatchedAt)], ["상태 변경", clock(request.stateSince)]]} /><Link prefetch={false} className="text-button" href={request.state === "indeterminate" ? MODEL_REQUEST_REVIEW_HREF : "/admin/status?tab=jobs"}>원본 근거·조치 →</Link></details></td></tr>)}
    {!observation.requests.length && <tr><td colSpan={6}>{unavailable ? "열린 요청을 읽지 못했습니다." : "현재 표시할 열린 요청이 없습니다. 종료 이력과 업무 기록은 별도입니다."}</td></tr>}
  </DataTable></Panel>;
}
