import Link from "next/link";
import { AI_CLI_TOOL_LABELS } from "@/lib/llm/ai-tasks";
import { formatCount, formatKst } from "@/lib/operations/console-tasks";
import { formatSeconds, MODEL_ADD_HREF, modelCompareHref, modelHref, modelKeyText, modelMaxTokens, type ModelConsoleRow, type ModelDeviceState }
  from "@/lib/operations/model-console";
import type { ModelConsoleRead } from "@/lib/operations/model-console-read";
import { SAMPLE_COMPARE_SUPPORTED } from "@/lib/operations/model-sample-compare";
import { MODELS_DASHBOARD_HREF } from "../../workspace-navigation";
import { ModelSettingsForm } from "./ModelSettingsForm";
import "./model-console.css";

/**
 * 운영 콘솔 「모델」 목록(2026-11-12 최종 시안 화면 4) — 모델 한 줄 = 사용자가 정한 이름 하나. 사용률 순.
 * 줄의 이름을 누르면(?model=<연결 id>) 아래에 상세가 열린다 — 설정 · 쓰는 단계 · 문제 · 조치. 서버가 알려 준 모델 이름·엔진 경로는 상세의 「연결 확인」에만.
 * 이 화면이 쓰는 저장은 기존 연결 저장(saveAiConnectionAction)과 장비 한 줄 저장(saveDeviceRowAction) — 저장 전 확인을 거친다(ModelSettingsForm).
 */
export function ModelConsole({ data, selected, readOnly }: { data: ModelConsoleRead; selected: string | null; readOnly: boolean }) {
  const { view } = data;
  const row = selected ? view.rows.find(entry => entry.id === selected) ?? null : null;
  const admission = data.admission;
  return <div className="model-console">
    <div className="mc-head">
      <h2>모델</h2><span className="mc-count">{formatCount(view.rows.length)}개 · 사용률 순 · 마지막 확인 {formatKst(view.checkedAt)}</span>
      <span className="mc-right">
        {!readOnly && <Link prefetch={false} className="button small primary" href={MODEL_ADD_HREF}>모델 추가</Link>}
        <Link prefetch={false} className="button small" href="/admin/models/compare">표본 비교</Link>
      </span>
    </div>
    {/* 접수가 열려 있지 않을 때만 — 옛 대시보드 주소(#admission)도 여기로 온다. 바꾸는 곳은 대시보드의 접수 칸이다 */}
    {admission && admission.mode !== "open" && <p id="admission" className="mc-notice" data-tone="warn">
      모델 접수 {admission.mode === "draining" ? "중단" : "꺼짐"}{admission.since ? ` · ${formatKst(admission.since)}부터` : ""} —{" "}
      <Link prefetch={false} href={`${MODELS_DASHBOARD_HREF}#admission`}>접수 바꾸기(대시보드)</Link></p>}
    {view.errors.map(error => <p key={error} role="alert" className="mc-notice">{error}</p>)}
    <div className="mc-scroll" role="region" aria-label="모델 목록" tabIndex={0}>
      <table className="mc-table" style={{ minWidth: 980 }}>
        <colgroup><col style={{ width: 176 }} /><col style={{ width: 116 }} /><col style={{ width: 64 }} /><col style={{ width: 76 }} /><col />
          <col style={{ width: 84 }} /><col style={{ width: 84 }} /><col style={{ width: 64 }} /><col style={{ width: 196 }} /></colgroup>
        <thead><tr><th scope="col">이름</th><th scope="col">장비</th><th scope="col" className="n">한도</th><th scope="col" className="n">지금</th>
          <th scope="col">24시간 사용률</th><th scope="col" className="n">호출</th><th scope="col" className="n">평균 응답</th><th scope="col" className="n">단계</th>
          <th scope="col">상태</th></tr></thead>
        <tbody>
          {view.rows.map(entry => <tr key={entry.id} data-selected={entry.id === selected ? "true" : undefined} data-model={entry.id}>
            <th scope="row"><Link prefetch={false} scroll={false} href={`${modelHref(entry.id)}#model-detail`}
              aria-current={entry.id === selected ? "true" : undefined}>{entry.name}</Link></th>
            <td className="q mc-machine" title={entry.machine}>{entry.machine}</td>
            <td className="n">{formatCount(entry.limit)}</td>
            <td className="n">{entry.active === null ? "—" : `${formatCount(entry.active)} / ${formatCount(entry.limit)}`}</td>
            <td><span className="mc-use" data-idle={entry.utilization !== null && entry.utilization < 0.05 ? "true" : undefined}>
              <span aria-hidden="true"><i style={{ width: `${entry.bar}%` }} /></span><b>{entry.utilizationText}</b></span></td>
            <td className="n">{entry.calls === null ? "—" : formatCount(entry.calls)}</td>
            <td className="n">{formatSeconds(entry.avgSeconds)}</td>
            <td className="n">{entry.stageCount ? formatCount(entry.stageCount) : "—"}</td>
            <td><span className="mc-st" data-tone={entry.status.tone}><i aria-hidden="true" />{entry.status.text}</span></td>
          </tr>)}
          {!view.rows.length && <tr><td colSpan={9} className="q">{view.errors.length ? "모델을 읽지 못했습니다." : "아직 모델이 없습니다. 「모델 추가」로 넣으세요."}</td></tr>}
        </tbody>
      </table>
    </div>
    <p className="mc-muted">사용률 = 24시간 호출 시간 합 ÷ (86,400초 × 한도). 한도는 장비의 모델별 한도 → 장비 한도 → 연결 칸 수 순서로 실제 걸리는 값입니다.
      옛 화면(대시보드·LLM 운영·장비 한도·계약)은 「고급 설정」에서 엽니다.</p>
    {selected && !row && <p role="alert" className="mc-notice">고른 모델을 찾지 못했습니다(지워졌거나 목록을 읽지 못함).</p>}
    {row && <ModelDetail row={row} device={data.devices?.find(device => device.deviceId === row.deviceId) ?? null} secretBox={data.secretBox} readOnly={readOnly}
      now={view.checkedAt} siblings={view.rows.filter(entry => entry.id !== row.id && entry.deviceId === row.deviceId).map(entry => ({ name: entry.name, models: entry.models }))} />}
  </div>;
}

const LIMIT_SOURCE: Record<ModelConsoleRow["limitSource"], string> = { model: "장비의 모델별 한도", device: "장비 한도", connection: "연결 칸 수(장비 행 없음)" };

/** 상세 — 머리(이름·상태·숫자) · 설정 · 쓰는 단계 · 문제 · 연결 확인. 설정·조치는 저장 전 확인을 거치는 폼(ModelSettingsForm) */
export function ModelDetail({ row, device, secretBox, readOnly, now, siblings = [] }: { row: ModelConsoleRow; device: ModelDeviceState | null; secretBox: boolean; readOnly: boolean;
  now: string; siblings?: readonly { name: string; models: readonly string[] }[] }) {
  const { connection } = row;
  const keyText = modelKeyText(connection, now);
  const compareTask = row.stages.find(stage => SAMPLE_COMPARE_SUPPORTED.includes(stage.task))?.task ?? SAMPLE_COMPARE_SUPPORTED[0];
  return <article id="model-detail" className="mc-detail" aria-labelledby="model-detail-title" data-model-detail={row.id}>
    <section>
      <div className="mc-head"><h3 id="model-detail-title">{row.name}</h3>
        <span className="mc-st" data-tone={row.status.tone}><i aria-hidden="true" />{row.status.text}</span>
        <span className="mc-right"><Link prefetch={false} className="text-button" href="/admin/models" scroll={false}>닫기</Link></span></div>
      <p className="mc-kv"><span>24시간 호출<b>{row.calls === null ? "—" : formatCount(row.calls)}</b></span>
        <span>결과 없이 끝남<b>{row.noResult === null ? "—" : formatCount(row.noResult)}</b></span>
        <span>미확정<b>{row.indeterminate === null ? "—" : formatCount(row.indeterminate)}</b></span>
        <span>평균 응답<b>{formatSeconds(row.avgSeconds)}</b></span>
        <span>사용률<b>{row.utilizationText}</b></span></p>
    </section>
    <section aria-label="설정">
      <span className="mc-lab">설정</span>
      <dl className="mc-dl">
        <dt>방식</dt><dd>{connection.kind === "api" ? "API 주소" : `CLI · ${connection.cliTool ? AI_CLI_TOOL_LABELS[connection.cliTool] : "도구 미확인"}`}</dd>
        {connection.host && <><dt>주소</dt><dd className="num">{connection.host}</dd></>}
        <dt>동시 한도</dt><dd className="num">{formatCount(row.limit)} <span className="mc-muted">· {LIMIT_SOURCE[row.limitSource]}{row.sharedWith.length ? ` · 같은 장비: ${row.sharedWith.join(" · ")}` : ""}</span></dd>
        {connection.kind === "api" && <><dt>최대 토큰</dt><dd className="num">{modelMaxTokens(connection) === null ? "—" : formatCount(modelMaxTokens(connection)!)}
          {!connection.contextTokens && modelMaxTokens(connection) !== null && <span className="mc-muted"> · 서버가 알려 준 값</span>}</dd>
          <dt>추론 여유</dt><dd className="num">{connection.reasoningTokenReserve ? formatCount(connection.reasoningTokenReserve) : "—"}</dd></>}
        <dt>쓸 단계</dt><dd>{connection.allowedTasks?.length ? `${connection.allowedTasks.length}개만 허용` : "모든 단계"}</dd>
        {connection.kind === "api" && <><dt>키</dt><dd className="num">{keyText ?? "없음"}</dd></>}
      </dl>
      <ModelSettingsForm row={row} device={device} secretBox={secretBox} readOnly={readOnly} siblings={siblings} />
    </section>
    {/* id — ⌘K 「이 모델을 쓰는 단계」가 이 자리로 보낸다(조각 4b) */}
    <section id="model-stages" aria-label="쓰는 단계">
      <span className="mc-lab">쓰는 단계</span>
      {row.stages.length ? <ul className="mc-cause">{row.stages.map(stage => <li key={`${stage.task}#${stage.slot}`}><span>{stage.place}</span>
        <span><Link prefetch={false} href={stage.href}>{stage.label}</Link>{stage.paused ? <span className="mc-muted"> · 사람이 멈춤</span> : null}</span></li>)}</ul>
        : <p className="mc-muted">쓰는 단계가 없습니다.</p>}
      <div className="mc-acts">
        <Link prefetch={false} className="button small" href="/admin/models/tasks">작업 배정</Link>
        {connection.enabled && <Link prefetch={false} className="button small" href={modelCompareHref(compareTask, row.id, row.models[0] ?? null)}>표본 비교</Link>}
      </div>
    </section>
    <section aria-label="문제">
      <span className="mc-lab">문제</span>
      {row.problems.length ? <ul className="mc-cause">{row.problems.map(problem => <li key={problem.key}><span>{problem.label}</span>
        <span>{problem.text}{problem.href ? <> <Link prefetch={false} href={problem.href}>{problem.action ?? "보기"} →</Link></> : null}</span></li>)}</ul>
        : <p className="mc-muted">읽은 값에서 문제를 찾지 못했습니다.</p>}
    </section>
    <section aria-label="연결 확인">
      <span className="mc-lab">연결 확인</span>
      <p className="mc-muted">서버가 알려 준 이름{row.served.length ? "" : " 없음"}
        {row.served.map((group, index) => <span key={group.ids.join("\u0000")}>{index ? " · " : ": "}<code>{group.ids.join(" = ")}</code>
          {group.maxModelLen ? ` (최대 ${formatCount(group.maxModelLen)})` : ""}</span>)}
        {connection.modelsReadAt ? ` · ${formatKst(connection.modelsReadAt)} 읽음` : ""}{` · 장비 id ${row.deviceId}`}{connection.note ? ` · 메모: ${connection.note}` : ""}</p>
    </section>
  </article>;
}
