"use client";
import { useActionState, useState } from "react";
import { requestSampleComparisonAction, type SampleCompareActionState } from "./actions";

export type SampleCandidate = { id: string; name: string; limit: number; utilization: string; models: string[]; model: string };

/** 후보 모델(사용률이 낮은 순) · 서버 이름(별칭이 여럿이면) · 표본 수 → 요청. 요청은 기록만 남기고 부르는 일은 배경 잡이 한다 */
export function SampleCompareRequestForm({ task, candidates, selected, defaultSize, maxSize, readOnly }: { task: string; candidates: readonly SampleCandidate[];
  selected: string | null; defaultSize: number; maxSize: number; readOnly: boolean }) {
  const [state, action, pending] = useActionState<SampleCompareActionState, FormData>(requestSampleComparisonAction, null);
  const [pick, setPick] = useState(candidates.find(row => row.id === selected)?.id ?? candidates[0]?.id ?? "");
  const chosen = candidates.find(row => row.id === pick) ?? null;
  const [model, setModel] = useState(chosen?.model ?? "");
  return <form action={action} className="mc-form">
    <input type="hidden" name="task" value={task} />
    <fieldset><legend>후보 모델 — 사용률이 낮은 순서</legend>
      <ul className="mc-pick">{candidates.map(row => <li key={row.id}><label>
        <input type="radio" name="candidate" value={row.id} checked={pick === row.id} onChange={() => { setPick(row.id); setModel(row.model); }} />
        <span>{row.name}</span><span>한도 {row.limit} · 사용률 {row.utilization}</span></label></li>)}</ul></fieldset>
    {chosen && chosen.models.length > 1 ? <label><span>서버 이름</span><select name="model" value={model} onChange={event => setModel(event.target.value)}>
      {chosen.models.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      : <input type="hidden" name="model" value={chosen?.model ?? ""} />}
    <label><span>표본 수</span><input className="num" type="number" name="size" min={1} max={maxSize} defaultValue={defaultSize} /></label>
    <p className="mc-hint">그 작업의 실제 대기 일감에서 고르게 고릅니다(곧 처리될 맨 앞은 뺍니다). 지금 모델과 후보 모델을 같은 묶음으로 한 번씩 부르고, 결과는 비교 기록에만 남습니다.
      후보가 이 단계를 처음 쓰면 작업 배정의 순위 저장과 같은 확인(1토큰 시험)으로 부를 길을 먼저 만듭니다 — 순위는 바꾸지 않습니다.</p>
    <div className="mc-acts"><button type="submit" className="button small primary" disabled={readOnly || pending || !chosen}>{pending ? "요청 중…" : "표본 비교 시작"}</button></div>
    {state?.ok && <p role="status" className="mc-msg">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="mc-msg">{text}</p>)}
  </form>;
}
