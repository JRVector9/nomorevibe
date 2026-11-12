"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { unifiedTaskImpactSummary, unifiedTaskSavesConfirmed } from "@/lib/operations/model-unified-task-view";
import type { AssignmentPreview } from "@/lib/operations/stage-panel-model";

export type UnifiedTaskSaveResult = {
  kind: "execution" | "ranks"; ok: boolean; message: string; issues: readonly string[]; warnings: readonly string[];
};

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
      <p className="ut-success"><i aria-hidden="true">✓</i>모델과 작업 현황이 함께 바뀌었습니다.</p>
      <p className="ut-drawer-lead">홈도 이 배정을 사용합니다. 아래에서 같은 값인지 확인할 수 있습니다.</p>
      <div className="ut-preview-chain ut-after"><div className="ut-label">{mode === "workload_pool" ? "동시에" : "순위대로"}</div>{chain}</div>
      {results.flatMap(result => result.warnings).map(warning => <p className="ut-callout ut-warn" role="alert" key={warning}>{warning}</p>)}
      <div className="ut-editor-foot"><Link href={homeHref} prefetch={false} className="ut-text-btn" onClick={onClose}>홈 배정 확인 →</Link>
        <button type="button" className="ut-btn ut-primary" onClick={onClose}>확인</button></div>
      <details className="ut-save-receipts"><summary>저장 내역</summary>{results.map((result, index) => <p key={`${index}:${result.kind}`}>
        <b>{result.kind === "ranks" ? "순위" : "실행 방식"} 저장함</b>{result.message ? ` · ${result.message}` : ""}</p>)}</details>
    </> : <>
      {results.map((result, index) => <div key={`${index}:${result.kind}`} className={`ut-callout${result.ok ? "" : " ut-warn"}`}><b>{result.kind === "ranks" ? "순위" : "실행 방식"} {result.ok ? "저장함" : "저장 못 함"}</b>
        {result.message && <p>{result.message}</p>}{result.issues.map(issue => <p role="alert" key={issue}>{issue}</p>)}{result.warnings.map(warning => <p role="alert" key={warning}>{warning}</p>)}</div>)}
      {results.some(result => result.ok) && results.some(result => !result.ok) && <p className="ut-callout ut-warn">일부 변경만 저장됐습니다. 최근 기록과 현재 적용 값을 확인한 뒤 다시 편집하세요.</p>}
      <p className="ut-scope-note">현재 적용 값과 최근 변경 기록을 다시 읽습니다. 다시 편집하려면 이 창을 닫고 해당 작업을 여세요.</p>
      <div className="ut-editor-foot"><p>새 업무부터 반영됩니다.</p><button type="button" className="ut-btn ut-primary" onClick={onClose}>확인</button></div>
    </>}
  </div>;
}
