import Link from "next/link";
import { formatListTime } from "@/lib/format/time";
import { AI_TASK_IMPORT_CONFIRM } from "@/lib/operations/admin-ai-tasks";
import type { ModelUnifiedRead } from "@/lib/operations/model-unified-read";
import { llmHistoryHref } from "@/lib/operations/llm-ops-history";
import { actionLabel, targetLabel } from "../../activity/labels";
import { summaryLine } from "../../activity/summary";
import { SettingsFieldsForm } from "../limits/SettingsFieldsForm";
import { AssistControlsCard } from "../tasks/AssistControlsCard";
import { ClearRecordsButton } from "../tasks/ConnectionButtons";
import { TaskImportCard } from "../tasks/TaskImportCard";

type Data = Pick<ModelUnifiedRead, "now" | "assist" | "concurrency" | "importPreview" | "retired" | "changes">;
export type UnifiedRecentChange = { id: number; at: string; title: string; detail: string; ok: boolean };

export function UnifiedOperations({ data, readOnly, recent }: { data: Data; readOnly: boolean; recent?: readonly UnifiedRecentChange[] }) {
  const { assist, concurrency, retired, importPreview, changes } = data;
  const sending = assist.controls.filter(control => control.mode !== "off" && control.dispatchEnabled).length;
  const rows: readonly UnifiedRecentChange[] = recent ?? changes.rows.map(row => ({ id: row.id, at: new Date(row.createdAt).toISOString(),
    title: `${targetLabel(row.target).text} · ${actionLabel(row.action)}`, detail: `${row.ok ? summaryLine(row) : row.error ?? "저장 거절"} · ${row.actor}`, ok: row.ok }));
  return <div id="operations" className="mu-lower">
    <section aria-labelledby="operations-title">
      <div className="mu-section-head"><h2 id="operations-title">운영 설정</h2><span>필요할 때 열기</span></div>
      <div className="mu-folds">
        <details id="assist-controls"><summary>LLM 보강 제어 <span>{assist.error ? "읽지 못함" : `보내기 ${sending} / ${assist.controls.length}개`}</span></summary>
          <div className="mu-fold-content"><p>보강 작업의 모델은 위 작업 목록에서 고릅니다. 여기서는 호출과 제품 반영을 제어합니다.</p>
            <AssistControlsCard controls={assist.controls} error={assist.error} readOnly={readOnly} /></div>
        </details>
        <details id="concurrency"><summary>동시 업무·호출 한도 <span>2차 {concurrency.fields[0]?.input ?? "?"}건 · 발행 분류 {concurrency.fields[1]?.input ?? "?"}개</span></summary>
          <div className="mu-fold-content"><p>모델별 칸 수는 작업 상세에서, 작업 전체의 동시 업무와 호출 상한은 아래에서 관리합니다.</p>
            {concurrency.rowError && <p role="alert">동시 업무 설정을 읽지 못했습니다({concurrency.rowError}). 기본값을 보이며 저장할 수 없습니다.</p>}
            <SettingsFieldsForm group="jobs" fields={concurrency.fields} revision={concurrency.revision} readOnly={readOnly || concurrency.revision === null}
              units={{ "jobs.second-review.consumerConcurrency": "건", "jobs.crawl-publish.classifierConcurrency": "개" }} />
            <div className="mu-manage-row"><span>작업별 호출 상한·틱 시간<small>실측과 역할별 반영 상태를 함께 확인합니다.</small></span>
              <Link prefetch={false} href="/admin/models/limits">실시간 한도 보기 →</Link></div>
          </div>
        </details>
        <details id="cleanup" open={!!importPreview || undefined}><summary>옛 설정 정리 <span>가져오기 · 쓰지 않는 순위 기록</span></summary>
          <div className="mu-fold-content">
            <details id="import" open={!!importPreview || undefined}><summary>옛 설정 가져오기 <span>비어 있는 작업의 순위만 채웁니다</span></summary>
              <fieldset disabled={readOnly} className="mu-import"><TaskImportCard preview={importPreview} confirmWord={AI_TASK_IMPORT_CONFIRM} /></fieldset>
              {readOnly && <p>읽기 전용 미리보기 — 가져오기를 적용할 수 없습니다.</p>}
            </details>
            <details id="retired-records"><summary>없앤 작업의 순위 기록 <span>{retired.reduce((total, entry) => total + entry.count, 0)}개</span></summary>
              <p>실행 쪽이 더는 읽지 않는 기록입니다. 지워도 실행 동작은 바뀌지 않습니다.</p>
              {retired.length ? <ul className="mu-retired">{retired.map(entry => <li key={`${entry.task}#${entry.slot}`} id={`execution-${entry.task}-${entry.slot}`}>
                <span>{entry.label} · 순위 {entry.count}개</span>{!readOnly && <ClearRecordsButton {...entry} />}
              </li>)}</ul> : <p>정리할 옛 순위 기록이 없습니다.</p>}
            </details>
          </div>
        </details>
      </div>
    </section>
    <section id="audit" aria-labelledby="history-title">
      <div className="mu-section-head"><h2 id="history-title">최근 변경</h2><Link prefetch={false} href={llmHistoryHref()}>기록 전체 →</Link></div>
      <div className="mu-recent">
        {changes.error ? <p role="alert" className="mu-empty">최근 변경을 읽지 못했습니다.</p> : rows.length ? rows.slice(0, 3).map(row => <div key={row.id} className="mu-recent-row">
          <time dateTime={row.at} title={formatListTime(row.at, new Date(data.now))}>{new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(row.at))}</time>
          <div><strong data-ok={row.ok}>{row.title}</strong><p>{row.detail}</p></div>
        </div>) : <p className="mu-empty">아직 변경 기록이 없습니다.</p>}
      </div>
      <div className="mu-mini-foot"><span>홈의 변경 기록과 같은 배정 내역</span><span>최근 {Math.min(rows.length, 3)}건</span></div>
    </section>
  </div>;
}
