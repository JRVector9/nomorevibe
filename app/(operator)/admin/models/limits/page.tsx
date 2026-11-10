import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { formatListTime } from "@/lib/format/time";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { readRuntimeSettingsAdminView } from "@/lib/operations/admin-runtime-settings";
import { GROUP_LABELS } from "@/lib/operations/runtime-settings-schema";
import { PageStamp } from "../../components/PageStamp";
import { modelsAdvancedEditor } from "../../workspace-navigation";
import { AdvancedEditorLinks, advancedEditorTitle } from "../advanced/AdvancedEditorLinks";
import { SettingsApplyLine } from "../../settings/SettingsApplyLine";
import { AssignmentsForm } from "./AssignmentsForm";
import { BudgetsForm } from "./BudgetsForm";
import { CapacityForm } from "./CapacityForm";
import { RoutesForm } from "./RoutesForm";
import { TranslationForm } from "./TranslationForm";
import { llmHistoryHref, RECENT_AUDIT_ROWS } from "@/lib/operations/llm-ops-history";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: advancedEditorTitle("limits"), robots: { index: false } };
const EDITOR = modelsAdvancedEditor("limits");

const ENV_TITLE = "이 역할은 MODEL_REGISTRY_CONFIG env 로 돌아 경로 한도 저장이 반영되지 않습니다";

/**
 * 실시간 한도(runtime_settings, PR 1a) — 경로 한도·번역 묶음·틱 예산을 저장하면 배포 없이 각 워커가 30초 안에 다음 틱부터 쓴다.
 * 머리의 「읽은 판」이 어느 역할이 이미 새 판으로 도는지 보인다. 장비별 칸 수는 「장비 한도」 화면이 맡는다(이 화면에 자리표시 묶음을 두지 않는다).
 */
export default async function RuntimeLimitsPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  await ensureServingContracts(0);
  const now = new Date();
  const view = await readRuntimeSettingsAdminView(now);
  const readOnly = view.revision === null;
  const envRoles = view.roles.filter(role => role.registryEnv);
  const badges = Object.fromEntries(envRoles.map(role => [role.role, { label: "env 등록부", title: ENV_TITLE }]));
  return <main className="mx-auto grid max-w-6xl gap-6 p-4">
    <PageStamp />
    <header className="grid gap-1">
      <AdvancedEditorLinks next={["devices"]} />
      <h1 className="text-[22px] font-semibold">{EDITOR.label}</h1>
      <p className="text-[13px] text-fg-3">저장하면 배포 없이 각 워커가 30초 안에 다음 틱부터 씁니다. 아래 &apos;읽은 판&apos;으로 어느 역할이 이미 새 판으로 도는지 봅니다.
        저장 문서는 바꾼 값만 담고(덮어씀), 나머지는 코드 기본값입니다.</p>
      <p className="text-[13px] text-fg-2">저장 판 <span className="font-mono">{view.shortVersion}</span>
        {view.revision !== null && <> · revision <span className="font-mono">{view.revision}</span></>}
        {view.updatedBy && <> · 마지막 저장 {view.updatedBy} {formatListTime(view.updatedAt, now)}</>}</p>
      {view.apply ? <SettingsApplyLine apply={view.apply} now={now} badges={badges} />
        : <p id="apply" className="text-[13px] text-fg-3">읽은 판을 아직 확인하지 못했습니다(적용 확인 읽기 실패 또는 준비 전).</p>}
      {envRoles.length > 0 && <p className="text-[13px] text-amber-700">{envRoles.map(role => role.label).join("·")} — {ENV_TITLE}. 번역·묶음·틱 예산은 반영됩니다.</p>}
      {view.rowError && <p role="alert" className="text-[13px] text-red-600">저장 행을 읽지 못했습니다({view.rowError}). 아래 값은 코드 기본값이며 저장할 수 없습니다.</p>}
      {view.issues.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">저장 문서 문제 — {text}</p>)}
      {view.warnings.map(text => <p key={text} role="note" className="text-[13px] text-amber-700">경고 — {text}</p>)}
    </header>
    <section id="routes" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">{GROUP_LABELS.routes}</h2>
      <p className="text-[13px] text-fg-3">용도(경로)마다 출력 토큰 상한·동시 호출·호출 상한입니다. 실제 호출은 여기 값과 등록부 모델 상한 중 작은 쪽을 씁니다.
        MODEL_REGISTRY_CONFIG env 가 있는 앱은 그 JSON 을 그대로 써서 이 묶음이 닿지 않습니다.</p>
      <RoutesForm routes={view.routes} ladders={view.ladders} revision={view.revision} readOnly={readOnly} />
    </section>
    <section id="translation" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">{GROUP_LABELS.translation}</h2>
      <TranslationForm translation={view.translation} jobKnobs={view.jobKnobs} revision={view.revision} readOnly={readOnly} />
    </section>
    <section id="budgets" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">{GROUP_LABELS.budgets}</h2>
      <BudgetsForm budgets={view.budgets} revision={view.revision} readOnly={readOnly} />
    </section>
    <section id="assignments" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">{GROUP_LABELS.assignments}</h2>
      <p className="text-[13px] text-fg-3">단계별 모델 고르기가 <Link href={modelsAdvancedEditor("assignments").href} className="underline">{modelsAdvancedEditor("assignments").label}</Link>를 읽는지(켬) 설정(legacy)을 읽는지(끔)입니다.
        저장하면 웹·reviewer·text·소비자가 30초 안에 같은 값을 읽습니다 — 재배포 없음. 켜기 전에 배정 화면에서 「현재 설정 → 배정 표 가져오기」로 행을 채우고 상태 띠를 확인합니다.</p>
      <AssignmentsForm fields={view.assignments} revision={view.revision} readOnly={readOnly} />
    </section>
    <section id="capacity" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">{GROUP_LABELS.capacity}</h2>
      <p className="text-[13px] text-fg-3">결과 미확정(확인 못함) 호출이 칸을 얼마나 오래 차지하는지입니다. 이 시간 안의 미확정 호출은 장비·모델 한도에서 「미확정 점유」로 보이고
        새 호출을 그만큼 막습니다. 장비별 칸 수는 <Link href={modelsAdvancedEditor("devices").href} className="underline">{modelsAdvancedEditor("devices").label}</Link>가 맡습니다.</p>
      <CapacityForm fields={view.capacity} revision={view.revision} readOnly={readOnly} />
    </section>
    <section id="audit" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">최근 저장 {Math.min(view.audit.length, RECENT_AUDIT_ROWS)}건</h2>
      {view.audit.length === 0 ? <p className="text-[13px] text-fg-3">아직 저장 기록이 없습니다.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[13px]"><thead><tr className="border-b border-line">
          <th className="py-2 pr-3">시각</th><th className="py-2 pr-3">누가</th><th className="py-2 pr-3">묶음 · revision</th><th className="py-2 pr-3">바뀐 값</th></tr></thead>
          <tbody>{view.audit.slice(0, RECENT_AUDIT_ROWS).map(row => <tr key={row.id} className="border-b border-line align-top">
            <td className="py-2 pr-3 whitespace-nowrap">{formatListTime(row.at, now)}</td>
            <td className="py-2 pr-3">{row.actor}</td>
            <td className="py-2 pr-3">{row.group}{row.revision !== null && <> · <span className="font-mono">{row.revision}</span></>}{!row.ok && <span className="ml-1 text-red-600">거절</span>}</td>
            <td className="py-2 pr-3">{row.ok ? (row.changes.length ? row.changes.map(line => <div key={line}>{line}</div>) : "—") : <span className="text-red-600">{row.error ?? "거절"}</span>}</td>
          </tr>)}</tbody></table></div>}
      <Link href={llmHistoryHref({ kind: "limit" })} prefetch={false} className="text-[13px] font-semibold text-accent-ink">LLM 운영 › 기록에서 전체 보기 →</Link>
    </section>
  </main>;
}
