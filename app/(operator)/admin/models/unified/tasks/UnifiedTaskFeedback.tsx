"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { unifiedTaskImpactSummary, unifiedTaskSavesConfirmed } from "@/lib/operations/model-unified-task-view";
import type { AssignmentPreview } from "@/lib/operations/stage-panel-model";
import type { AssignmentSaveResult } from "@/lib/operations/model-assignment-save";

export type UnifiedTaskSaveResult = AssignmentSaveResult;

/** Critical facts stay in the confirmation. The complete sharing/device inventory is available without repeating it above the action. */
export function UnifiedTaskImpact({ taskLabel, impact, deviceNotes, help }: {
  taskLabel: string; impact: AssignmentPreview["impact"]; deviceNotes: readonly string[]; help?: ReactNode;
}) {
  return <>
    {impact.filter(entry => entry.tone !== "info").map(entry => <p className="ut-scope-note ut-actual-warning" role="alert" key={entry.text}>{unifiedTaskImpactSummary(entry.text)}</p>)}
    <div className="ut-scope-note ut-confirm-impact"><span className="ut-impact-label">영향을 받는 작업: <b>{taskLabel}</b></span>
      진행 중인 호출은 유지됩니다. 새 업무부터 반영되며, 모델 목록과 홈의 작업 배정도 같은 값으로 바뀝니다.
      {(impact.length > 0 || deviceNotes.length > 0 || help) && <details className="ut-impact-details"><summary>영향 자세히</summary><div>
        {impact.map(entry => <p className={entry.tone === "info" ? undefined : "ut-actual-warning"} key={entry.text}>{entry.text}</p>)}
        {deviceNotes.map(note => <p key={note}>{note}</p>)}
        {help}
      </div></details>}
    </div>
  </>;
}

/** The success preview describes the reviewed draft only after the existing actions confirmed every required write. */
export function UnifiedTaskResult({ results, expected, mode, chain, homeHref, onClose }: {
  results: readonly UnifiedTaskSaveResult[]; expected: readonly ("execution" | "ranks")[];
  mode: "fallback" | "workload_pool"; chain: string; homeHref: string; onClose: () => void;
}) {
  const confirmed = unifiedTaskSavesConfirmed(results, expected);
  return <div role="status" className="ut-save-results">
    {confirmed ? <>
      <p className="ut-success"><i aria-hidden="true">✓</i>배정 설정을 저장했습니다.</p>
      <p className="ut-drawer-lead">새 업무부터 이 배정을 사용합니다. 저장 확인은 실제 호출 성공과 다릅니다. 최근 실행에서 처리 여부를 확인하세요.</p>
      <div className="ut-preview-chain ut-after"><div className="ut-label">{mode === "workload_pool" ? "동시에" : "순위대로"}</div>{chain}</div>
      {results.flatMap(result => result.warnings).map(warning => <p className="ut-callout ut-warn" role="alert" key={warning}>{warning}</p>)}
      <div className="ut-editor-foot"><Link href={homeHref} prefetch={false} className="ut-text-btn" onClick={onClose}>홈 배정 확인 →</Link>
        <button type="button" className="ut-btn ut-primary" onClick={onClose}>확인</button></div>
      <details className="ut-save-receipts"><summary>저장 내역</summary>{results.map((result, index) => <p key={`${index}:${result.kind}`}>
        <b>{result.kind === "ranks" ? "순위" : "실행 방식"} 저장함</b>{result.message ? ` · ${result.message}` : ""}</p>)}</details>
    </> : <>
      {results.map((result, index) => <div key={`${index}:${result.kind}`} className={`ut-callout${result.ok ? "" : " ut-warn"}`}><b>{result.kind === "ranks" ? "순위" : "실행 방식"} {result.unconfirmed ? "저장 여부 미확인" : result.ok ? "저장함" : "저장 못 함"}</b>
        {result.message && <p>{result.message}</p>}{result.issues.map(issue => <p role="alert" key={issue}>{issue}</p>)}{result.warnings.map(warning => <p role="alert" key={warning}>{warning}</p>)}</div>)}
      {results.some(result => result.ok) && results.some(result => !result.ok) && <p className="ut-callout ut-warn">{results.some(result => result.unconfirmed)
        ? "일부 저장만 확인했습니다. 나머지도 적용됐을 수 있으니 최근 기록과 현재 배정을 확인하세요."
        : "일부 변경만 저장됐습니다. 최근 기록과 현재 적용 값을 확인한 뒤 다시 편집하세요."}</p>}
      <p className="ut-scope-note">현재 적용 값과 최근 변경 기록을 다시 읽도록 요청했습니다. 다시 편집하려면 이 창을 닫고 해당 작업을 여세요.</p>
      <div className="ut-editor-foot"><p>{results.some(result => result.unconfirmed) ? "응답이 없는 저장의 적용 여부는 아직 모릅니다." : "저장된 변경은 새 업무부터 반영됩니다."}</p><button type="button" className="ut-btn ut-primary" onClick={onClose}>{results.some(result => result.unconfirmed) ? "새로고침해서 적용 확인" : "확인"}</button></div>
    </>}
  </div>;
}
