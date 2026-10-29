"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AdminModelsObservation, AdminModelMetrics } from "@/lib/operations/admin-models-observation";
import { elapsedModelTime, modelIdentityKey } from "@/lib/operations/admin-models-view";
import { probeAdminModel, type ModelProbeResult } from "./operation-actions";
import { buttonSmall, hintClass } from "../settings/Switch";

const states = { waiting: "보류 · 접수 대기", reserved: "예약", dispatched: "진행 중", indeterminate: "미확인 · indeterminate" };
const stamp = (at: string | null) => at ? at.replace("T", " ").replace("Z", " UTC") : "기록 없음";
import { ModelOpsPanel } from "./ModelOpsPanel";
import type { OpsState } from "@/lib/operations/ops-runner/contract";

export function LiveModels({ observation, probeAction = probeAdminModel, opsStates = [], restartModels = [], opsActions }: {
  observation: AdminModelsObservation; probeAction?: typeof probeAdminModel; opsStates?: OpsState[];
  restartModels?: { key: string; label: string }[];
  opsActions?: Pick<React.ComponentProps<typeof ModelOpsPanel>, "submitAction" | "readAction">;
}) {
  const router = useRouter(), [busy, start] = useTransition();
  const [probes, setProbes] = useState<Record<string, ModelProbeResult>>({});
  const runProbe = (row: AdminModelMetrics) => start(async () => {
    const key = modelIdentityKey(row);
    try {
      const next = await probeAction({ routeId: row.routeId, provider: row.provider, model: row.model });
      setProbes(current => ({ ...current, [key]: next }));
    } catch { setProbes(current => ({ ...current, [key]: { error: "연결 확인 결과를 읽지 못했습니다. 감사 기록과 연결 상태를 확인해주세요." } })); }
  });
  return <section className="flex min-w-0 flex-col gap-4 rounded-xl border border-line bg-bg-card p-5" aria-labelledby="live-models-heading">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="live-models-heading" className="text-[18px] font-semibold">실제 동작·미확인 요청</h2>
      <button type="button" className={buttonSmall} disabled={busy} onClick={() => router.refresh()}>실측 새로고침</button></div>
    {observation.error ? <p role="alert">{observation.error}</p> : <>
      <p>접수 <strong>{observation.mode?.toUpperCase()}</strong> · 관측 {stamp(observation.observedAt)}</p>
      <p className={hintClass}>최근 1시간 성공·실패는 장부에 남은 모델 응답 종료 판정입니다. 업무 승인·발행 성공과 다릅니다. 판정할 수 없는 종료는 미분류로 표시하며, 응답이 안 끝난 요청은 미확인에 남깁니다.</p>
      <div className="flex flex-wrap gap-2">{observation.groups.map(group => <span key={group.groupId} className="rounded-lg border border-line px-3 py-2 text-[13px] break-all">
        {group.groupId} · 점유 {group.held}/{group.limit ?? "상한 미확인"}</span>)}</div>
      <p className={hintClass}>예약·진행 중·미확인은 모두 슬롯을 점유합니다. 예약 기한이 지나도 이 화면은 해제하지 않습니다. {observation.policyVerified ? `전체 상한 ${observation.globalLimit}` : "정책 검증 실패 · 상한 미확인"}</p>
      <ModelOpsPanel mode={observation.mode} requests={observation.requests.filter(row => row.state === "indeterminate")}
        models={restartModels} initialStates={opsStates} {...opsActions} />
      <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]">
        <thead><tr><th className="p-2">단계·모델·그룹</th><th className="p-2">1시간 성공 / 실패 / 철회 / 미분류</th><th className="p-2">진행 / 미확인 / 예약 / 보류</th><th className="p-2">마지막 성공</th><th className="p-2">연결 확인</th></tr></thead>
        <tbody>{observation.rows.map(row => <tr key={`${modelIdentityKey(row)}|${row.groupId}|${row.providerBudgetId}`} className="border-t border-line align-top">
          <th className="max-w-[260px] break-words p-2 font-normal"><strong>{row.routeId}</strong><br />{row.provider} · {row.model}<br /><span className={hintClass}>{row.groupId} / {row.providerBudgetId}</span></th>
          <td className="p-2 tabular-nums">{row.succeeded1h} / {row.failed1h} / {row.withdrawn1h} / {row.unclassified1h}</td>
          <td className="p-2 tabular-nums">{row.dispatched} / {row.indeterminate} / {row.reserved} / {row.waiting}</td>
          <td className="p-2">{stamp(row.lastSuccessAt)}</td>
          <td className="max-w-[240px] p-2"><button type="button" className={buttonSmall} disabled={busy || !["abcllm", "local-direct"].includes(row.provider)} onClick={() => runProbe(row)}>연결 확인</button>
            {!["abcllm", "local-direct"].includes(row.provider) && <p className={hintClass}>모델 목록 조회 실행기 연결 필요</p>}
            {probes[modelIdentityKey(row)] && <ProbeNotice result={probes[modelIdentityKey(row)]} />}</td>
        </tr>)}</tbody></table></div>
      <h3 className="text-[16px] font-semibold">미확인·보류·예약·진행 중 요청</h3>
      {observation.truncated && <p role="alert">요청이 100건을 넘습니다. 미확인 우선으로 100건만 표시하며 위 점유 합계에는 모든 요청을 포함합니다.</p>}
      {!observation.requests.length && <p>현재 남아 있는 요청이 없습니다.</p>}
      {observation.requests.map(request => <article key={request.requestId} className="flex min-w-0 flex-col gap-2 rounded-lg border border-line p-3 text-[13px]">
        <p><strong>{states[request.state]}</strong> · {request.routeId} · {request.model}</p>
        <p className="break-all font-mono">{request.requestId} · {request.groupId} · {request.ownerInstanceId}</p>
        <p>발생 {stamp(request.stateSince)} · 상태 경과 {elapsedModelTime(request.stateSince, observation.observedAt)} · 접수 후 {elapsedModelTime(request.queuedAt, observation.observedAt)}</p>
        {request.reservedUntil && <p>예약 기한 {stamp(request.reservedUntil)}</p>}
        {request.localEndRecorded && <p>로컬 호출 종료 기록 있음 · 모델 제공자의 종료 증거는 별도 확인이 필요합니다.</p>}

      </article>)}
    </>}
  </section>;
}

function ProbeNotice({ result }: { result: ModelProbeResult }) {
  return <div role="status" className="mt-2 flex flex-col gap-1 text-[13px]">
    <p>{result.listed === undefined ? "목록 미확인" : result.listed ? "모델 목록에 있음" : "모델 목록에 없음"} · {result.listMs ?? "—"}ms</p>
    {result.error && <p>{result.error}</p>}<p>시험 호출: {result.callMs === undefined ? result.callBlocked : `${result.callMs}ms`}</p>
  </div>;
}
