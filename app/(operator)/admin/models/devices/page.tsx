import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { formatListTime } from "@/lib/format/time";
import { capacityDeviceIssueMessage, readCapacityDevicesAdminView } from "@/lib/operations/admin-capacity-devices";
import { readEngineLimitMetadata } from "@/lib/operations/admin-engine-limits";
import { PageStamp } from "../../components/PageStamp";
import { DeviceForm } from "./DeviceForm";
import { DeviceTable } from "./DeviceTable";
import { SharedLimitForm } from "./SharedLimitForm";
import { llmHistoryHref, RECENT_AUDIT_ROWS } from "@/lib/operations/llm-ops-history";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "엔진 공유 한도 — NoMoreVibe", robots: { index: false } };

/**
 * 장비 한도(model_capacity_devices·model_capacity_device_roles, PR 1b) — 장비별 칸 수·낮은 순위 상한·유휴 판정·비워 둘 칸·역할 순서를 저장하면
 * 입장 판정이 트랜잭션 안에서 이 표를 바로 읽어 다음 입장부터 쓴다. 정책 세대(hash)와 분리되어 DRAIN·배포·"읽은 판"이 없다.
 * 점유는 예약+진행만 센다 — 미확인(indeterminate) 행은 점유가 아니다.
 */
export default async function CapacityDevicesPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  const now = new Date();
  const [view, engines] = await Promise.all([readCapacityDevicesAdminView(now), readEngineLimitMetadata()]);
  const readOnly = view.rowsError !== null;
  const mapped = view.devices.flatMap(device => {
    const engine = engines.engines.find(engine => engine.deviceId === device.deviceId);
    return engine?.connections.length ? [{ device, engine }] : [];
  });
  return <main className="mx-auto grid max-w-6xl gap-6 p-4">
    <PageStamp />
    <header className="grid gap-1">
      <p className="flex flex-wrap gap-4 text-[13px] text-fg-3"><Link href="/admin/models/limits">← 실시간 한도</Link><Link href="/admin/models">← 단계별 모델</Link><Link href="/admin/models/helpers">도우미 장비 →</Link></p>
      <h1 className="text-[22px] font-semibold">엔진 공유 한도</h1>
      <p className="text-[15px] text-fg-2">같은 엔진을 사용하는 1차·2차 검수와 글 짓기 등 모든 작업이 하나의 동시 실행 한도를 나눠 씁니다. 예를 들어 5건으로 저장하면 각 단계의 예약·실행 합계가 최대 5건입니다.</p>
      <p className="text-[13px] text-fg-3">저장하면 입장 판정이 트랜잭션 안에서 이 표를 바로 읽어
        <strong> 다음 입장부터</strong> 쓰입니다 — DRAIN·배포·&apos;읽은 판&apos;이 없습니다. 이미 잡힌 행(예약·진행)은 그대로이고 한도를 낮추면 새 입장만 막힙니다.
        경로→장비 매핑을 바꾸는 것만 정책 개정(DRAIN)입니다.</p>
      <p className="text-[13px] text-fg-2">접수 <strong>{view.mode?.toUpperCase() ?? "미확인"}</strong>
        {view.epoch !== null && <> · 정책 epoch <span className="font-mono">{view.epoch}</span> revision <span className="font-mono">{view.revision}</span></>}
        {" · "}장비 {view.devices.length}대{view.lendingCount > 0 && <> · 지금 빌려 쓰는 중 {view.lendingCount}대</>}</p>
      {view.controlError && <p role="alert" className="text-[13px] text-red-600">용량 제어 행을 읽지 못했습니다({capacityDeviceIssueMessage(view.controlError)}) — 정책 경로 없이 장비 행만 보입니다.</p>}
      {view.rowsError && <p role="alert" className="text-[13px] text-red-600">장비 행을 읽지 못했습니다({capacityDeviceIssueMessage(view.rowsError)}). 아래 값은 정책 대체값이며 저장할 수 없습니다.</p>}
      {view.statesError && <p role="note" className="text-[13px] text-amber-700">실시간 상태를 읽지 못했습니다({capacityDeviceIssueMessage(view.statesError)}) — 점유·빌려 쓰기 칸이 비어 있습니다.</p>}
      {view.issues.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">정책 문제 — {text}</p>)}
    </header>
    <section id="shared-limits" className="grid gap-3">
      <h2 className="text-[18px] font-semibold">등록된 엔진 ({mapped.length})</h2>
      {engines.error && <p role="alert" className="text-[15px] text-amber-700">등록 연결과 공유 작업을 확인하지 못했습니다. 새로고침해 주세요. 기존 장비 설정은 아래에서 확인할 수 있습니다.</p>}
      <div className="grid gap-4 lg:grid-cols-2">{mapped.map(({ device, engine }) => <SharedLimitForm
        key={`${device.deviceId}#${device.version ?? "new"}#${engines.policyHash}`} device={device} engine={engine} policyHash={engines.policyHash!}
        readOnly={readOnly || !view.policyVerified || !device.enabled} />)}</div>
      {!engines.error && !mapped.length && <p className="text-[15px] text-fg-3">현재 정책과 연결된 등록 엔진이 없습니다. 고급 설정에서 정책 그룹을 확인해 주세요.</p>}
      {mapped.length < view.devices.length && <p className="text-[13px] text-fg-3">등록 연결이 확인되지 않은 정책 그룹 {view.devices.length - mapped.length}개는 고급 설정에 표시합니다. 다른 그룹의 한도를 같은 엔진 한도로 대신 적용하지 않습니다.</p>}
    </section>
    <details className="grid gap-4 rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-[17px] font-semibold">고급 설정 · 전체 정책 그룹, 역할 우선순위</summary>
      <div className="mt-4 grid gap-6">
    <section id="devices" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">장비 목록 ({view.devices.length})</h2>
      <p className="text-[13px] text-fg-3">점유는 예약+진행만 셉니다(미확인 행은 점유가 아닙니다). 「빌려 쓰는 중」은 우선 역할이 유휴라 낮은 순위 역할이 평소 상한을 넘어 쓰는 상태이며,
        우선 역할 요청이 오면 새 낮은 순위 입장은 바로 멈추고 빈 칸은 우선 역할로 갑니다(진행 중 호출은 끊지 않습니다).</p>
      <DeviceTable devices={view.devices} now={now} />
    </section>
    <section id="edit" className="grid gap-4 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">장비별 설정</h2>
      {view.devices.length === 0 && <p className="text-[13px] text-fg-3">장비가 없습니다 — 아래에서 새 장비를 만들거나 정책을 적용하세요.</p>}
      {view.devices.map(device => <DeviceForm key={device.deviceId} device={device} readOnly={readOnly} />)}
    </section>
    <section id="new" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">새 장비</h2>
      <p className="text-[13px] text-fg-3">정책에 아직 없는 장비 이름도 받습니다(예: 장비를 나누기 전에 행을 먼저 만들고 정책을 적용). 이름은 정책 경로의 groupId 와 같아야 합니다.</p>
      <DeviceForm device={null} readOnly={readOnly} />
    </section>
      </div>
    </details>
    <section id="audit" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">최근 저장 {Math.min(view.audit.length, RECENT_AUDIT_ROWS)}건</h2>
      {view.audit.length === 0 ? <p className="text-[13px] text-fg-3">아직 저장 기록이 없습니다.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[13px]"><thead><tr className="border-b border-line">
          <th className="py-2 pr-3">시각</th><th className="py-2 pr-3">누가</th><th className="py-2 pr-3">장비 · 판</th><th className="py-2 pr-3">바뀐 값</th></tr></thead>
          <tbody>{view.audit.slice(0, RECENT_AUDIT_ROWS).map(row => <tr key={row.id} className="border-b border-line align-top">
            <td className="py-2 pr-3 whitespace-nowrap">{formatListTime(row.at, now)}</td>
            <td className="py-2 pr-3">{row.actor}</td>
            <td className="py-2 pr-3"><code>{row.deviceId}</code>{row.version !== null && <> · <span className="font-mono">{row.version}</span></>}{!row.ok && <span className="ml-1 text-red-600">거절</span>}</td>
            <td className="py-2 pr-3">{row.ok ? (row.changes.length ? row.changes.map(line => <div key={line}>{line}</div>) : "—") : <span className="text-red-600">{row.error ? capacityDeviceIssueMessage(row.error) : "거절"}</span>}</td>
          </tr>)}</tbody></table></div>}
      <Link href={llmHistoryHref({ kind: "limit" })} prefetch={false} className="text-[13px] font-semibold text-accent-ink">LLM 운영 › 기록에서 전체 보기 →</Link>
    </section>
  </main>;
}
