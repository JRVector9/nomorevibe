import Link from "next/link";
import type { AssignmentRowView, AssignmentStageGroupView } from "@/lib/operations/admin-model-assignments";
import { TurnOffButton } from "./TurnOffButton";

const TH = "py-2 pr-3 text-[13px] font-semibold text-fg-3";
const TD = "py-2 pr-3 align-top";
const num = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toLocaleString("ko-KR");
const SOURCE_CLASS: Record<AssignmentStageGroupView["source"], string> = {
  table: "bg-emerald-100 text-emerald-900", legacy: "bg-bg-soft text-fg-2", table_empty: "bg-amber-100 text-amber-900",
};

function ModelCell({ row }: { row: AssignmentRowView }) {
  if (row.role === "helper") return <code className="break-all">{row.model}</code>;
  return <><code className="font-semibold">{row.registryKey}</code>
    <div className="text-fg-3">→ <code className="break-all">{row.model}</code></div>
    {row.registryLabel && <div className="text-fg-3">{row.registryLabel}</div>}</>;
}

function ContractCell({ row }: { row: AssignmentRowView }) {
  const { contract } = row;
  if (contract.state === "present") return <><span className="font-semibold">있음</span> <code title="계약 hash 앞 12자리">{contract.hashPrefix}</code>
    {contract.transportMismatch && <div className="text-amber-700">전송 다름</div>}</>;
  if (contract.state === "missing") return <span className={row.mode === "live" ? "font-semibold text-red-600" : "text-fg-3"}>{contract.label}</span>;
  return <span className="text-fg-3">{contract.label}</span>;
}

function Row({ row, vote, readOnly }: { row: AssignmentRowView; vote: boolean; readOnly?: boolean }) {
  return <tr className="border-b border-line" data-assignment={row.assignmentId} data-role={row.role}>
    <td className={TD}><code className="font-semibold">{row.deviceId}</code>{row.deviceName && <div className="text-fg-3">{row.deviceName}</div>}
      <div className="font-mono text-fg-3">{row.assignmentId}</div>
      {row.issues.length > 0 && <ul className="mt-1 grid gap-0.5 text-amber-700">{row.issues.map(text => <li key={text}>{text}</li>)}</ul>}</td>
    <td className={TD}><ModelCell row={row} /></td>
    <td className={TD}>{row.transportLabel}</td>
    <td className={`${TD} tabular-nums`}>{num(row.rank)}</td>
    <td className={TD}>{row.roleLabel}</td>
    {vote && <td className={TD}>{row.role === "helper" ? "—" : row.vote ? <strong>투표</strong> : <span className="text-fg-3">아님</span>}</td>}
    <td className={TD}><span className={row.mode === "off" ? "text-fg-3" : "font-semibold"}>{row.modeLabel}</span></td>
    <td className={TD}><ContractCell row={row} /></td>
    <td className={TD}><span className={row.route.state === "present" ? "font-semibold" : row.route.state === "missing" && row.mode === "live" ? "text-red-600" : "text-fg-3"}>
      {row.route.label}</span><div className="font-mono text-fg-3">{row.routeId}</div></td>
    <td className={`${TD} tabular-nums`}>{num(row.deviceRoleRank)}</td>
    <td className={`${TD} tabular-nums`}>{num(row.settled1h)}</td>
    <td className={`${TD} font-mono`}>{row.version}</td>
    <td className={TD}>{row.helperHref
      ? <Link href={row.helperHref} prefetch={false} className="font-semibold text-accent-ink underline">도우미 화면에서 →</Link>
      : <div className="grid gap-1">
        {row.editHref && <Link href={row.editHref} prefetch={false} className="font-semibold text-accent-ink underline">수정</Link>}
        {row.mode === "live" && <TurnOffButton assignmentId={row.assignmentId} version={row.version} disabled={readOnly} />}
      </div>}</td>
  </tr>;
}

/**
 * 단계 한 묶음의 배정 표 — 장비 · 모델(등록부 key → wire) · 전송 · 순위 · 역할 · 표(2차만) · 모드 · 계약(있음 + hash 앞자리) · route(지금 정책에 있나) ·
 * 장비 역할 순위 · 최근 1시간 정산 건수 · 판 · 동작(수정·끄기; 도우미 행은 도우미 화면으로). 색만으로 가르지 않고 글자를 낸다.
 */
export function AssignmentStageTable({ group, readOnly }: { group: AssignmentStageGroupView; readOnly?: boolean }) {
  return <section id={`stage-${group.id}`} className="grid gap-2 rounded-xl border border-line bg-bg-card p-4 scroll-mt-6" data-stage={group.id}>
    <div className="flex flex-wrap items-baseline gap-2">
      <h3 className="text-[16px] font-semibold">{group.label}</h3>
      <span className="font-mono text-[13px] text-fg-3">{group.id}{group.routeId && <> · {group.routeId}</>}</span>
      <span data-source={group.source} className={`rounded-full px-2 text-[13px] font-semibold ${SOURCE_CLASS[group.source]}`}>읽기 {group.sourceLabel}</span>
      <span className="text-[13px] text-fg-3">전송 {group.transportLabel}{group.vote && " · 표(투표)는 순위 1 만"}</span>
    </div>
    {group.reserved ? <p className="text-[13px] text-fg-3">예약 단계입니다 — 경로 규칙이 정해지면(3b-B) 배정할 수 있습니다.</p>
      : group.rows.length === 0 ? <p className="text-[13px] text-fg-3">배정이 없습니다{group.source === "legacy" ? " — 지금은 설정(단계별 모델·크롤 설정)을 읽습니다" : ""}.</p>
      : <div className="overflow-x-auto"><table className="w-full min-w-[1180px] text-left text-[13px]"><thead><tr className="border-b border-line">
        <th className={TH}>장비</th><th className={TH}>모델</th><th className={TH}>전송</th><th className={TH}>순위</th><th className={TH}>역할</th>
        {group.vote && <th className={TH}>표</th>}<th className={TH}>모드</th><th className={TH}>계약</th><th className={TH}>route</th>
        <th className={TH}>장비 역할 순위</th><th className={TH}>최근 1시간</th><th className={TH}>판</th><th className={TH}>동작</th></tr></thead>
        <tbody>{group.rows.map(row => <Row key={row.assignmentId} row={row} vote={group.vote} readOnly={readOnly} />)}</tbody></table></div>}
  </section>;
}
