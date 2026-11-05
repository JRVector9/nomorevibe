import type { Station } from "./conveyor-model";

export type FlowStageBadge = { label: string; tone: "green" | "amber" | "red" | "gray"; why: string };
type Job = { paused: boolean; lastError: boolean; execution?: "locked" | "stale" | "none" };

/** Queue growth alone is not an incident. Only observed worker/lock failures receive an outage label. */
export function flowStageBadge(station: Station, jobs: readonly (Job | undefined)[], admission: string | null): FlowStageBadge {
  const known = jobs.filter((job): job is Job => !!job);
  const currentCalls = !station.llm || station.llm.kind === "unknown" ? null : station.llm.kind === "llm"
    ? station.llm.tasks.some(task => task.active == null) ? null : station.llm.tasks.reduce((total, task) => total
      + (task.active ?? []).filter(row => row.state === "dispatched").reduce((sum, row) => sum + row.count, 0), 0) : 0;
  if (known.some(job => job.execution === "stale")) return { label: "장애", tone: "red", why: "실행 잠금이 만료된 작업이 있습니다." };
  if (/워커 끊김|반복 재시작/.test(station.status)) return { label: "장애", tone: "red", why: station.reason ?? station.status };
  if (known.length && known.every(job => job.paused) || station.tone === "stop")
    return { label: currentCalls === null || currentCalls > 0 || known.some(job => job.execution === "locked") ? "신규 중지" : "일시정지", tone: "gray",
      why: `새 작업 실행이 일시 중지됐습니다.${currentCalls === null ? " 기존 호출 상태는 미확인입니다." : currentCalls > 0 ? ` 기존 전송 ${currentCalls}건은 진행 중입니다.` : ""}` };
  if (station.llm?.kind === "llm" && station.llm.stopped.length)
    return { label: "설정 필요", tone: "red", why: station.llm.stopped.join(" · ") };
  if (station.llm?.kind === "llm" && admission?.toLowerCase() === "draining")
    return { label: "접수 정지", tone: "amber", why: `모델 DRAIN 중입니다. ${currentCalls === null ? "기존 호출 상태는 미확인입니다." : `기존 전송 ${currentCalls}건은 실제 종료까지 관측합니다.`}` };
  if (known.some(job => job.paused)) return { label: "부분 정지", tone: "amber", why: "일부 작업만 일시 중지됐습니다." };
  if (station.tone === "unknown") return { label: "미확인", tone: "gray", why: station.reason ?? "현재 관측을 읽지 못했습니다." };
  if (!station.llm || station.llm.kind === "unknown") return { label: "확인 필요", tone: "amber", why: "모델 설정 관측을 읽지 못했습니다. 처리량 정상 여부와 구분합니다." };
  if (station.llm.kind === "llm" && station.llm.tasks.some(task => task.legacy?.ready === false))
    return { label: "연결 필요", tone: "amber", why: "기존 CLI 연결 에이전트가 현재 분류 요청을 받을 수 없습니다." };
  if (known.some(job => job.lastError)) return { label: "오류 확인", tone: "amber", why: "최근 작업 오류가 있습니다. 상세 실행 기록을 확인하세요." };
  if (station.tone === "jam") return { label: "정체", tone: "red", why: station.reason ?? "대기 업무의 진행이 관측되지 않습니다." };
  if (station.tone === "slow") return { label: station.holds.some(hold => hold.count > 0) ? "보류" : "적체", tone: "amber", why: station.reason ?? "처리할 업무가 쌓이고 있습니다." };
  if (station.tone === "idle") return { label: "대기 없음", tone: "gray", why: "현재 집계된 대기 업무가 없습니다." };
  return { label: "원활", tone: "green", why: "처리량 관측에서 정체나 중지 신호가 없습니다." };
}
