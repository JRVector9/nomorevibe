import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { formatListTime } from "@/lib/format/time";
import { capacityDeviceIssueMessage, readCapacityDevicesAdminView } from "@/lib/operations/admin-capacity-devices";
import { buildDeviceTableRows, staleRouteItems } from "@/lib/operations/admin-capacity-device-table-view";
import { capacityRetireIssueMessage, readAdminStaleCapacityRoutes } from "@/lib/operations/admin-capacity-retire";
import { listAiConnections } from "@/lib/operations/admin-ai-tasks-repository";
import { readAdminModelsObservation } from "@/lib/operations/admin-models-repository";
import { readSettingsControl, UNKNOWN_HOLD_CONTROL } from "@/lib/operations/admin-runtime-settings";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { cliTaskUsagesByDevice, readCliTaskUsages, type CliTaskUsageView } from "@/lib/operations/cli-task-usage";
import { deviceDisplay } from "@/lib/operations/llm-display";
import { PageStamp } from "../../components/PageStamp";
import { modelsAdvancedEditor } from "../../workspace-navigation";
import { AdvancedEditorLinks, advancedEditorTitle } from "../advanced/AdvancedEditorLinks";
import { DeviceForm } from "./DeviceForm";
import { CliTaskRows } from "./CliTaskRows";
import { DeviceLimitsTable, type DeviceCliRows } from "./DeviceLimitsTable";
import { DeviceName, DeviceTable, type DeviceNames } from "./DeviceTable";
import { StaleRoutesPanel } from "./StaleRoutesPanel";
import { CapacityForm } from "../limits/CapacityForm";
import { llmHistoryHref, RECENT_AUDIT_ROWS } from "@/lib/operations/llm-ops-history";
import "./devices.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: advancedEditorTitle("devices"), robots: { index: false } };
const EDITOR = modelsAdvancedEditor("devices");

/**
 * 장비 한도(model_capacity_devices·model_capacity_device_roles, PR 1b; 2026-11-09 개편 시안 #devices) — 서버 한 대가 한 줄인 표 하나.
 * 운영 한도(칸 수)·모델 한도를 저장하면 입장 판정이 트랜잭션 안에서 이 표를 바로 읽어 다음 입장부터 쓴다 — DRAIN·배포·"읽은 판"이 없다.
 * 점유는 예약+진행+결과 미확정 점유(유지 시간 안의 indeterminate, 2026-11-10 — 입장과 같은 규칙)를 센다. 역할 순서·유휴 시간·비워 둘 칸·새 장비는 맨 아래 「세부 설정」에 접어 둔다.
 *
 * CLI(Claude·Codex) 장비 줄 아래에는 작업별 「모델 ▾ · 추론 강도 ▾」 줄(CliTaskRows)을 끼운다 — 읽기는 readCliTaskUsages, 저장은 devices/cli-actions.
 */
export default async function CapacityDevicesPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  const now = new Date();
  const [view, connections, observation, stale, cli, unknownHold] = await Promise.all([readCapacityDevicesAdminView(now), listAiConnections().catch(() => null),
    readAdminModelsObservation({ throughput: false }).catch(() => null), readAdminStaleCapacityRoutes(),
    readCliTaskUsages().catch((): CliTaskUsageView => ({ usages: [], unavailable: ["CLI 작업별 모델·추론 강도를 읽지 못했습니다."] })),
    readSettingsControl(UNKNOWN_HOLD_CONTROL)]);
  const { byDevice: cliByDevice, unmapped: cliUnmapped } = cliTaskUsagesByDevice(cli.usages);
  const cliRows: DeviceCliRows = Object.fromEntries(Object.entries(cliByDevice).map(([deviceId, usages]) => [deviceId, <CliTaskRows key={deviceId} usages={usages} columns={7} />]));
  // 장비 이름 = 그 장비를 쓰는 연결 이름(장비 id 는 정책 groupId 라 옆에 작게 둔다). 연결이 없는 장비는 「연결 없음」
  const names: DeviceNames = Object.fromEntries([...view.devices.map(device => device.deviceId), ...view.audit.slice(0, RECENT_AUDIT_ROWS).map(row => row.deviceId)].map(deviceId => {
    const display = deviceDisplay(deviceId, connections, observation);
    return [deviceId, { name: display.name, connected: connections === null ? null : display.source !== "id" }];
  }));
  const readOnly = view.rowsError !== null || adminWorkspaceReadOnly();
  const rows = buildDeviceTableRows({ devices: view.devices, connections, observation, readOnly });
  const active = view.devices.reduce((sum, device) => sum + (device.live?.active ?? 0), 0);
  const waiting = view.devices.reduce((sum, device) => sum + (device.live?.waiting ?? 0), 0);
  return <main className="devlim mx-auto grid max-w-6xl gap-4 p-4">
    <PageStamp />
    <header className="devlim-head">
      <div className="grid gap-1">
        <AdvancedEditorLinks next={["allocation", "limits", "helpers"]} />
        <h1 className="text-[22px] font-semibold">{EDITOR.label}</h1>
      </div>
      <p className="devlim-meta">
        <span>접수 <b>{view.mode?.toUpperCase() ?? "미확인"}</b></span>
        <span>서버 <b>{view.devices.length}</b></span>
        {view.statesError === null && <span>지금 <b>{active}</b> · 대기 <b>{waiting}</b></span>}
        {view.lendingCount > 0 && <span>빌려 쓰는 중 <b>{view.lendingCount}</b></span>}
        <Link href={llmHistoryHref({ kind: "limit" })} prefetch={false} className="devlim-link">저장 기록 →</Link>
      </p>
    </header>
    <p className="devlim-lede">한도는 그 서버의 모든 작업이 함께 쓰는 동시 실행 수입니다. 저장하면 다음 입장부터 쓰고, 낮춰도 진행 중 호출은 끝까지 갑니다.</p>
    {view.controlError && <p role="alert" className="devlim-refusal">용량 제어 행을 읽지 못했습니다({capacityDeviceIssueMessage(view.controlError)}) — 정책 경로 없이 장비 행만 보입니다.</p>}
    {view.rowsError && <p role="alert" className="devlim-refusal">장비 행을 읽지 못했습니다({capacityDeviceIssueMessage(view.rowsError)}). 아래 값은 정책 대체값이며 저장할 수 없습니다.</p>}
    {view.statesError && <p role="note" className="devlim-note">실시간 상태를 읽지 못했습니다({capacityDeviceIssueMessage(view.statesError)}) — 지금·대기 칸이 비어 있습니다.</p>}
    {connections === null && <p role="note" className="devlim-note">AI 연결 목록을 읽지 못해 서버 이름을 장비 id 로 보이고, 지워도 되는지 판정하지 않습니다.</p>}
    {view.issues.map(text => <p key={text} role="alert" className="devlim-refusal">정책 문제 — {text}</p>)}
    {cli.unavailable.map(text => <p key={text} role="note" className="devlim-note">{text}</p>)}
    {cliUnmapped.length > 0 && <p role="note" className="devlim-note">장비를 알 수 없는 CLI 작업 {cliUnmapped.length}개: {cliUnmapped.map(usage => usage.taskLabel).join(" · ")}</p>}
    {rows.length ? <DeviceLimitsTable rows={rows} cliRows={cliRows} /> : <p className="devlim-note">장비가 없습니다 — 아래 세부 설정에서 새 장비를 만들거나 정책을 적용하세요.</p>}
    <StaleRoutesPanel items={staleRouteItems(stale.candidates, connections, observation)} revision={stale.revision} readOnly={readOnly}
      error={stale.error ? capacityRetireIssueMessage(stale.error) : null} />
    {/* 결과 미확정 점유(runtime_settings capacity.unknownHoldSeconds) — 2026-11-11 실시간 한도 개편으로 이 화면에 옮겼다. 입장 TX 가 행을 바로 읽어 저장 즉시 다음 입장부터 쓴다 */}
    <details className="devlim-panel devlim-details">
      <summary className="devlim-panel-head"><h2>결과 미확정 점유</h2> <span className="devlim-muted">미확정 호출이 장비 칸을 지금 {unknownHold.fields[0]?.input ?? "?"}초 동안 차지합니다</span></summary>
      <section id="unknown-hold" className="grid gap-2 p-4 scroll-mt-6">
        <p className="text-[13px] text-fg-3">결과를 확인하지 못한 호출(미확정)은 이 시간 동안 장비 칸을 계속 차지하고 새 호출을 그만큼 막습니다. 0.5초 만에 끝난 전송 실패도 같은 시간을 차지합니다.
          실시간 한도 화면의 「지금 볼 것」이 틱 끝에서 끊긴 미확정을 따로 알립니다.</p>
        {unknownHold.rowError && <p role="alert" className="devlim-refusal">실시간 한도 행을 읽지 못했습니다({unknownHold.rowError}) — 기본값을 보이며 저장할 수 없습니다.</p>}
        <CapacityForm fields={unknownHold.fields} revision={unknownHold.revision} readOnly={adminWorkspaceReadOnly() || unknownHold.revision === null} />
      </section>
    </details>
    <details className="devlim-panel devlim-details">
      <summary className="devlim-panel-head"><h2>세부 설정</h2> <span className="devlim-muted">역할 순서 · 유휴 시간 · 비워 둘 칸 · 엔진 실제 동시 처리 수 · 서버 추가 · 최근 저장</span></summary>
      <div className="grid gap-6 p-4">
        <section id="devices" className="grid gap-2 scroll-mt-6">
          <h3 className="text-[17px] font-semibold">장비 상태 ({view.devices.length})</h3>
          <DeviceTable devices={view.devices} now={now} names={names} />
        </section>
        <section id="edit" className="grid gap-4 scroll-mt-6">
          <h3 className="text-[17px] font-semibold">장비별 설정</h3>
          {view.devices.map(device => <DeviceForm key={device.deviceId} device={device} readOnly={readOnly} name={names[device.deviceId]?.name} />)}
        </section>
        <section id="new" className="grid gap-2 scroll-mt-6">
          <h3 className="text-[17px] font-semibold">새 장비</h3>
          <p className="text-[13px] text-fg-3">이름은 정책 경로의 groupId 와 같아야 합니다(정책에 아직 없는 이름도 받습니다).</p>
          <DeviceForm device={null} readOnly={readOnly} />
        </section>
        <section id="audit" className="grid gap-2 scroll-mt-6">
          <h3 className="text-[17px] font-semibold">최근 저장 {Math.min(view.audit.length, RECENT_AUDIT_ROWS)}건</h3>
          {view.audit.length === 0 ? <p className="text-[13px] text-fg-3">아직 저장 기록이 없습니다.</p>
            : <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[13px]"><thead><tr className="border-b border-line">
              <th className="py-2 pr-3">시각</th><th className="py-2 pr-3">누가</th><th className="py-2 pr-3">장비 · 판</th><th className="py-2 pr-3">바뀐 값</th></tr></thead>
              <tbody>{view.audit.slice(0, RECENT_AUDIT_ROWS).map(row => <tr key={row.id} className="border-b border-line align-top">
                <td className="py-2 pr-3 whitespace-nowrap">{formatListTime(row.at, now)}</td>
                <td className="py-2 pr-3">{row.actor}</td>
                <td className="py-2 pr-3"><DeviceName deviceId={row.deviceId} names={names} />{row.version !== null && <> · <span className="font-mono">{row.version}</span></>}{!row.ok && <span className="ml-1 text-red-600">거절</span>}</td>
                <td className="py-2 pr-3">{row.ok ? (row.changes.length ? row.changes.map(line => <div key={line}>{line}</div>) : "—") : <span className="text-red-600">{row.error ? capacityDeviceIssueMessage(row.error) : "거절"}</span>}</td>
              </tr>)}</tbody></table></div>}
        </section>
      </div>
    </details>
  </main>;
}
