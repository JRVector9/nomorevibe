"use client";
import type { JobKnobRow, SettingField } from "@/lib/operations/admin-runtime-settings";
import type { JobKnobName } from "@/lib/operations/runtime-settings-schema";
import { GroupForm, TD, TH, ValueCell } from "./fields";

// 열 순서 — 클라이언트 번들이라 schema 모듈(node:crypto)을 값으로 import 하지 않고 이름만 적는다(JOB_KNOB_NAMES 와 같은 집합)
const KNOB_ORDER: readonly JobKnobName[] = ["batch", "batchChars", "minCallMs", "slowCallMs", "soloAttempts", "callMs", "maxAttempts"];
const KNOB_HEADERS: Record<JobKnobName, string> = { batch: "묶음", batchChars: "묶음 글자", minCallMs: "최소 남은 시간(초)", slowCallMs: "느린 호출(초)",
  soloAttempts: "혼자 보내는 실패 수", callMs: "호출 상한(초)", maxAttempts: "최대 시도" };

/**
 * 번역·묶음 — 공개 번역 정책(translation 그룹)과 잡별 묶음(jobs 그룹)은 저장 묶음이 다르므로 폼이 둘이다.
 * 한 폼의 저장은 그 묶음의 바뀐 칸만 보낸다(다른 폼에 적어 둔 값은 함께 가지 않는다).
 */
export function TranslationForm({ translation, jobKnobs, revision, readOnly }: { translation: SettingField[]; jobKnobs: JobKnobRow[]; revision: number | null; readOnly?: boolean }) {
  const columns = KNOB_ORDER.filter(knob => jobKnobs.some(row => row.knobs[knob]));
  return <div className="grid gap-4">
    <GroupForm group="translation" revision={revision} readOnly={readOnly}>
      <h3 className="text-[15px] font-semibold">공개 번역</h3>
      <dl className="grid gap-3 sm:grid-cols-2">
        {translation.map(field => <div key={field.path} className="grid gap-1">
          <dt className="text-[13px] font-semibold">{field.label}</dt>
          <dd><ValueCell field={field} readOnly={readOnly} />
            {field.note && <p className="mt-1 max-w-prose text-[13px] text-fg-3">{field.note}</p>}</dd>
        </div>)}
      </dl>
    </GroupForm>
    <GroupForm group="jobs" revision={revision} readOnly={readOnly}>
      <h3 className="text-[15px] font-semibold">잡별 묶음</h3>
      <p className="text-[13px] text-fg-3">각 잡이 한 틱에 묶는 건수·글자와 호출을 시작할 최소 남은 시간입니다. 소개 생성의 동시 호출·호출 상한은 위 경로 한도의 <code>crawl-tagline</code> 줄입니다.</p>
      <div className="overflow-x-auto"><table className="w-full min-w-[880px] text-left text-[13px]"><thead><tr className="border-b border-line">
        <th className={TH}>잡</th>{columns.map(knob => <th key={knob} className={TH}>{KNOB_HEADERS[knob]}</th>)}</tr></thead>
        <tbody>{jobKnobs.map(row => <tr key={row.job} className="border-b border-line">
          <td className={TD}>{row.label}<br /><code className="text-[13px] text-fg-3">{row.job}</code></td>
          {columns.map(knob => <td key={knob} className={TD}>{row.knobs[knob] ? <ValueCell field={row.knobs[knob]!} readOnly={readOnly} unit={knob.endsWith("Ms") ? "초" : ""} />
            : <span className="text-fg-3">—</span>}</td>)}
        </tr>)}</tbody></table></div>
    </GroupForm>
  </div>;
}
