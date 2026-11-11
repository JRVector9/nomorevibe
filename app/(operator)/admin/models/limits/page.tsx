import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { shortSettingsVersion } from "@/lib/crawl/settings-version";
import { formatListTime } from "@/lib/format/time";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { readLimitsAdminView } from "@/lib/operations/admin-limits-repository";
import type { LimitsView } from "@/lib/operations/admin-limits-view";
import { llmHistoryHref, RECENT_AUDIT_ROWS } from "@/lib/operations/llm-ops-history";
import { PageStamp } from "../../components/PageStamp";
import { modelsAdvancedEditor } from "../../workspace-navigation";
import { AdvancedEditorLinks, advancedEditorTitle } from "../advanced/AdvancedEditorLinks";
import { LimitsEditor } from "./LimitsEditor";
import "./limits.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: advancedEditorTitle("limits"), robots: { index: false } };
const EDITOR = modelsAdvancedEditor("limits");

const STATE_TEXT: Readonly<Record<LimitsView["roles"][number]["state"], string>> = { applied: "지금 판", waiting: "옛 판", unknown: "판을 알리지 않음", inactive: "관측 없음",
  unread: "확인 못함" };

/** 머리의 「읽은 판」 한 줄 — 모두 같은 판이면 초록 하나, 아니면 옛 판·관측 없는 역할 수. 역할별 표는 아래 진단에 접어 둔다 */
function AppliedLine({ view, now }: { view: LimitsView; now: Date }) {
  const lagging = view.roles.filter(role => role.state === "waiting" || role.state === "unknown");
  const idle = view.roles.filter(role => role.state === "inactive" || role.state === "unread");
  const env = view.roles.filter(role => role.registryEnv);
  return <p id="apply" className="lim-applied">
    {!view.apply ? <span className="lim-pill" data-level="off">읽은 판을 확인하지 못함</span>
      : view.apply.allApplied ? <span className="lim-pill" data-level="ok"><span aria-hidden="true" className="lim-pill-shape">●</span>모든 역할이 지금 판으로 도는 중</span>
        : <span className="lim-pill" data-level={lagging.length ? "warn" : "off"}><span aria-hidden="true" className="lim-pill-shape">{lagging.length ? "▲" : "‖"}</span>
          {lagging.length ? `${lagging.length}개 역할이 아직 옛 판` : `${idle.length}개 역할 관측 없음`}</span>}
    <span className="lim-muted">저장 판 <span className="lim-num">{view.shortVersion}</span>
      {view.revision !== null && <> · {view.revision}번째 저장</>}
      {view.updatedBy && <> · 마지막 저장 {view.updatedBy} {formatListTime(view.updatedAt, now)}</>}</span>
    <a href="#diag" className="lim-link">역할별 보기</a>
    {env.length > 0 && <span className="lim-bad-text">{env.map(role => role.label).join("·")}은(는) MODEL_REGISTRY_CONFIG env 로 돌아 호출 상한·동시 호출·응답 토큰 저장이 닿지 않습니다</span>}
  </p>;
}

/**
 * 실시간 한도(runtime_settings) — 2026-11-11 개편(승인 시안 limits-mock). AI 작업 한 줄에 한 번 호출 상한·한 틱 시간·동시 호출과 장부 24시간 실측을 둔다.
 * 저장하면 배포 없이 각 워커가 30초 안에 다음 틱부터 쓴다. 다른 화면이 쓰는 칸(결과 미확정 점유·공개 번역 한도·동시 업무·재판정)은 그 화면으로 옮겼다.
 * 옛 닻(#apply·#routes·#budgets·#capacity·#translation·#assignments·#audit)은 그대로 이 화면의 자리로 간다.
 */
export default async function RuntimeLimitsPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  await ensureServingContracts(0);
  const now = new Date();
  const view = await readLimitsAdminView(now);
  return <main className="lim mx-auto grid max-w-6xl gap-5 p-4">
    <PageStamp />
    <header className="lim-head">
      <AdvancedEditorLinks next={["devices", "allocation"]} />
      <h1>{EDITOR.label}</h1>
      <p className="lim-muted">AI 작업마다 한 번 부르는 시간, 한 틱에 쓰는 시간, 한꺼번에 보내는 양을 정합니다. 저장하면 배포 없이 30초 안에 반영됩니다.</p>
      <AppliedLine view={view} now={now} />
      <p className="lim-muted lim-small">{view.measuredAt ? <>실측: 모델 장부 최근 24시간 · {formatListTime(view.measuredAt, now)} 기준(1분마다 다시 셈)</>
        : <span role="note" className="lim-bad-text">측정을 읽지 못했습니다 — 실측 칸이 비어 있습니다. 칸은 그대로 고치고 저장할 수 있습니다.</span>}</p>
      {view.rowError && <p role="alert" className="lim-bad-text">저장 행을 읽지 못했습니다({view.rowError}). 아래 값은 코드 기본값이며 저장할 수 없습니다.</p>}
      {view.issues.map(text => <p key={text} role="alert" className="lim-bad-text">저장 문서 문제 — {text}</p>)}
    </header>

    <LimitsEditor view={view} />

    <section className="lim-panel" aria-labelledby="moved-title">
      <div className="lim-panel-head"><h2 id="moved-title">다른 화면에서 고치는 칸</h2><span className="lim-muted">그 값을 실제로 쓰는 화면으로 옮겼습니다</span></div>
      <div className="lim-panel-body"><div className="lim-moved">
        <div className="lim-card" id="capacity"><h3><Link href="/admin/models/devices#unknown-hold" prefetch={false} className="lim-link">장비 한도 › 세부 설정 →</Link></h3>
          <ul><li>결과 미확정이 칸을 차지하는 시간 (지금 {view.unknownHoldSeconds.toLocaleString("ko-KR")}초)</li></ul>
          <p className="lim-muted lim-small">장비 칸을 얼마나 오래 막는지는 장비 화면에서 칸 수와 함께 봅니다.</p></div>
        <div className="lim-card" id="translation"><h3><Link href="/admin/translations#limits" prefetch={false} className="lim-link">공개 번역 › 번역 한도 →</Link></h3>
          <ul><li>원문 글자 상한 · 묶음 글자 · 요청 보류 한도</li><li>최대 시도 (4보다 크게 해도 4회까지만 보냄)</li><li>묶음 최대 건수 4 (코드에 고정)</li></ul></div>
        <div className="lim-card"><h3><Link href="/admin/audit?tab=recheck" prefetch={false} className="lim-link">감사 › 변경 재판정 →</Link></h3>
          <ul><li>훑는 수 · 하루 상한 · 묻는 수</li><li>닮음 기준 · 1차 양보 시간</li></ul></div>
        <div className="lim-card" id="assignments"><h3><Link href="/admin/models/tasks#concurrency" prefetch={false} className="lim-link">작업 배정 › 동시 업무 →</Link></h3>
          <ul><li>2차 심사 소비자 동시 업무</li><li>발행 분류 동시 묶음</li></ul>
          <p className="lim-muted lim-small">배정 표 읽기 스위치는 <Link href={modelsAdvancedEditor("assignments").href} prefetch={false} className="lim-link">{modelsAdvancedEditor("assignments").label}</Link>에 있습니다.</p></div>
      </div></div>
    </section>

    <details className="lim-panel lim-fold">
      <summary>이 화면에서 뺀 칸 <span className="lim-muted">읽는 코드가 없거나 다른 값이 덮어씁니다 · 저장된 값은 지우지 않고 그대로 둡니다</span></summary>
      <div className="lim-gone">
        <div><h3>줄째로 뺀 경로</h3><ul><li>중계(relay) — 10-31 은퇴</li><li>Grok 세션 · Grok 심사 — 호출 없음</li><li>직접 연결 심사 — 동시 실행은 env(AUDIT_QWEN_CONCURRENCY)가 정함</li>
          <li>분류(Claude) · 분류(CLI) — 11-05 이후 CLI 발행 분류 호출 없음</li><li>사이트 근거 갱신 틱 — 한 번도 돈 적 없음</li><li>2차 심사 틱 — 소비자가 처리</li></ul></div>
        <div><h3>읽는 곳 없는 「동시 호출」</h3><ul><li>검색어 번역 · 분류(Claude) · 사람 큐 심사</li><li>사유 번역 · 소개 검수 · 심사 호출</li><li>중계 · 직접 연결 심사 · CLI 심사</li></ul>
          <p className="lim-muted lim-small">이 작업들의 동시 실행은 장비 한도가 정합니다. 화면에 남긴 동시 호출은 검색 키워드·공개 번역·소개 생성·키워드 검수·한국어 소개 다섯입니다.</p></div>
        <div><h3>옛 방식에서만 쓰던 값</h3><ul><li>한국어 소개 응답 토큰 · 묶음 글자(옛 경로 전용)</li><li>검색 키워드 「느린 호출」(10-31부터 읽지 않음)</li><li>CLI 심사 응답 토큰 · 동시 호출(덮어쓴 값)</li>
          <li>심사 호출(gateway-review)의 호출 상한</li><li>기한 사다리의 엔진 · 중계 · 게이트웨이(선언만) — 2차 심사 상한을 낮추면 저장이 순서를 맞춥니다</li>
          <li>「모델 상한(등록부)」 열 — 순위로 고르는 작업의 실제 모델과 다름</li><li>배정 표 읽기 — 표가 비어 있고 순위가 대신함</li></ul></div>
        <div><h3>빼기 전에 고친 숨은 연결</h3><ul><li>Grok 심사 상한(90초)이 OpenCode 1차 심사의 「보내는 중」 창(150초)을 정하고 있었습니다. 이제 1차 심사(CLI) 상한 + 60초로 셉니다.</li>
          <li>제품 감사 틱 검사가 CLI 상한을 보지 않았습니다. 이제 1차 심사(CLI) 상한도 봅니다.</li></ul></div>
      </div>
    </details>

    <details className="lim-panel lim-fold" id="diag">
      <summary>진단 — 역할별 읽은 판 <span className="lim-muted">{view.apply?.allApplied ? "모두 지금 판" : "역할마다 다름"}</span></summary>
      <div className="lim-scroll"><table className="lim-table">
        <thead><tr><th>역할</th><th>읽은 판</th><th>확인 시각</th><th>지금 도는 작업</th><th>비고</th></tr></thead>
        <tbody>{view.roles.map(role => <tr key={role.role}>
          <td>{role.label}</td>
          <td><span className="lim-pill" data-level={role.state === "applied" ? "ok" : role.state === "waiting" ? "warn" : "off"}>{STATE_TEXT[role.state]}
            {role.version ? <span className="lim-num">&nbsp;{shortSettingsVersion(role.version)}</span> : null}</span></td>
          <td className="lim-muted">{role.observedAt ? formatListTime(role.observedAt, now) : "—"}</td>
          <td className="lim-muted">{role.running.length ? role.running.join(" · ") : "—"}</td>
          <td className="lim-muted">{role.registryEnv ? "env 등록부 — 경로 한도 저장이 닿지 않음" : ""}</td>
        </tr>)}
          <tr><td>2차 심사 소비자 · 웹</td><td><span className="lim-pill" data-level="off">보고 안 함</span></td><td className="lim-muted">—</td><td className="lim-muted">—</td>
            <td className="lim-muted">같은 저장 행을 30초 스냅숏으로 읽지만 읽은 판을 알리지 않습니다</td></tr>
        </tbody></table></div>
    </details>

    <details className="lim-panel lim-fold" id="audit">
      <summary>최근 저장 {Math.min(view.audit.length, RECENT_AUDIT_ROWS)}건</summary>
      <div className="lim-panel-body">
        {view.audit.length === 0 ? <p className="lim-muted">아직 저장 기록이 없습니다.</p>
          : <div className="lim-scroll"><table className="lim-table">
            <thead><tr><th>시각</th><th>누가</th><th>묶음 · 판</th><th>바뀐 값</th></tr></thead>
            <tbody>{view.audit.slice(0, RECENT_AUDIT_ROWS).map(row => <tr key={row.id}>
              <td className="lim-nowrap">{formatListTime(row.at, now)}</td><td>{row.actor}</td>
              <td>{row.group}{row.revision !== null && <> · {row.revision}</>}{!row.ok && <span className="lim-bad-text"> 거절</span>}</td>
              <td>{row.ok ? (row.changes.length ? row.changes.map(line => <div key={line}>{line}</div>) : "—") : <span className="lim-bad-text">{row.error ?? "거절"}</span>}</td>
            </tr>)}</tbody></table></div>}
        <Link href={llmHistoryHref({ kind: "limit" })} prefetch={false} className="lim-link">LLM 운영 › 기록에서 전체 보기 →</Link>
      </div>
    </details>
  </main>;
}
