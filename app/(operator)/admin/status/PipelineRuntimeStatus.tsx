import type { PipelineControlStatus as Snapshot } from '@/lib/operations/pipeline-control-status';
import type { AnchorState, GateCheck, HostLedger, PipelineRuntimeStatus as Runtime } from '@/lib/operations/pipeline-runtime-status';
import { ROLE_LABELS } from '@/lib/operations/contracts';
import { formatDetailTime } from '@/lib/format/time';
import { ScrollTable } from '../components/ScrollTable';

const HOSTS: Record<string, string> = { m3: 'M3', mini: 'mini', 'oracle-osaka-smoke': 'Oracle · Osaka' };
const REASONS: Record<string, string> = { readback_unknown: '자료 없음', candidate_missing: '실행 후보 없음',
  identity_mismatch: 'host·릴리스 불일치', capability_unknown: '권한·자원 미확인', capability_stale: '권한·자원 관측 오래됨',
  result_unknown: '실제 결과 없음', result_stale: '실제 결과 오래됨', result_unverified: '결과 readback 미확인', ready: '준비조건 확인',
  anchor_invalid: 'anchor 형식 오류', anchor_identity_mismatch: 'anchor 대상 불일치', anchor_readback_mismatch: 'anchor readback 불일치' };
const ANCHORS: Record<string, string> = { pinned: 'anchor 고정', absent: 'anchor 없음', invalid: 'anchor 무효' };
const LEDGER: Record<HostLedger['state'], string> = { unknown: '미확인', absent: '장부 미참여', invalid: '장부 무효 · 새 일감 보류', ok: '장부 참여' };
const GATES: Record<string, string> = { batch: 'batch 정책의 Oracle instance', http: 'HTTP 장부 Oracle 매핑', ledger: 'host-slot 예산 장부', dr: 'DR writer fence' };
const GATE_REASONS: Record<string, string> = { batch_unverified: '정책 미확인', batch_not_versioned: '분리 배치 아님', oracle_instance_missing: 'Oracle instance 없음',
  oracle_instance_registered: '등록됨', http_unread: '자료 없음', http_policy_unverified: '정책 미확인', http_not_open: '장부 열림 아님',
  oracle_http_mapped: '매핑됨', oracle_http_unmapped: '매핑 없음', ledger_invalid: '장부 무효', ledger_participating: '프로세스 참여 관측',
  ledger_unread: '자료 없음', ledger_absent: '참여 프로세스 없음', writer_active: 'active', writer_fenced: 'fenced', fence_unread: '자료 없음' };
const STATUS: Record<GateCheck['status'], string> = { verified: '확인', unknown: '미확인', rejected: '거절' };
const EVIDENCE: Record<string, string> = { old_db_fenced: '옛 DB fence', old_db_isolated: '옛 DB 격리', writer_process_stopped: 'writer 정지',
  provider_deadline: 'provider 기한', independent_budget: '독립 예산', external_effects_reconciled: '외부 효과 정산', http_hops_released: 'HTTP hop 해제' };
const CAPABILITY: Record<string, string> = { verified: '확인', unknown: '미확인' };
const number = (value: number | null) => value === null ? '미확인' : value.toLocaleString('ko-KR');
const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;
const anchorLabel = (anchor: AnchorState) => anchor ? ANCHORS[anchor] : 'anchor 미확인';
const short = (value: string | null) => value === null ? '미확인' : value.length > 12 ? value.slice(0, 12) : value;
const note = 'mt-1 text-[13px] text-fg-3';

function Ledger({ ledger }: { ledger: HostLedger }) {
  if (ledger.state !== 'ok') return <p className={`text-[13px] ${ledger.state === 'invalid' ? 'text-down' : 'text-fg-2'}`}>예산 장부 · {LEDGER[ledger.state]}</p>;
  const rows: [string, string][] = [['프로세스', `${number(ledger.processes)} · 만료 행 ${number(ledger.expired)}`],
    ['DB client 합', `primary ${number(ledger.primaryClients)} · replica ${number(ledger.replicaClients)}`],
    ['heartbeat 최대 간격', ledger.heartbeatGapMs === null ? '—' : `${(ledger.heartbeatGapMs / 1000).toFixed(1)}초`],
    ['event loop 최대', ledger.eventLoopDelayMs === null ? '—' : `${number(Math.round(ledger.eventLoopDelayMs))}ms`],
    ['load/CPU 최대', ledger.loadPerCpu === null ? '—' : ledger.loadPerCpu.toFixed(2)],
    ['RSS 합', ledger.rssBytes === null ? '—' : `${number(Math.round(ledger.rssBytes / 1024 / 1024))}MB`],
    ['번역 slot', ledger.translationCap === null ? '해당 없음' : `${number(ledger.translationHeld)} / ${number(ledger.translationCap)}`]];
  return <div>
    <p className="text-[13px] text-fg-2">예산 장부 · {LEDGER.ok}{ledger.shapes !== null && ledger.shapes > 1
      && <span className="text-down"> · 정책 모양 {ledger.shapes}종 불일치 · 새 일감 보류</span>}</p>
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">{rows.map(([label, value]) => <div key={label} className="contents">
      <dt className="text-fg-3">{label}</dt><dd className="font-mono">{value}</dd></div>)}</dl>
  </div>;
}

function Dr({ dr }: { dr: Runtime['dr'] }) {
  return <section className="mt-4 rounded-[10px] border border-line p-3" aria-labelledby="pipeline-dr-title">
    <h3 id="pipeline-dr-title" className="text-[13px] font-semibold">DR writer fence</h3>
    {dr.state === null ? <p className={note}>자료 없음</p> : <>
      <p className={`mt-1 text-[13px] ${dr.state === 'fenced' ? 'text-down' : 'text-fg-2'}`}>
        {dr.state === 'active' ? '쓰기 가능 (active)' : `쓰기 차단 (fenced · ${dr.reason === 'promotion_sealed' ? '승격 봉인' : '운영자 차단'})`}
        {' · '}writer epoch <span className="font-mono">{number(dr.epoch)}</span>{dr.updatedAt && <> · 갱신 <time dateTime={dr.updatedAt}>{formatDetailTime(dr.updatedAt)}</time></>}</p>
      <p className="text-[13px] text-fg-2">진행 중 승격 {number(dr.sealed?.length ?? null)}건 · 완료한 승격 {number(dr.promoted)}건</p>
      {dr.sealed?.length ? <ul className="mt-1 space-y-1 text-[13px] text-fg-2">{dr.sealed.map(row => <li key={row.id}>
        승격 <span className="font-mono" title={row.id}>{row.id.slice(0, 8)}</span> · epoch {number(row.fromEpoch)}→{number(row.toEpoch)} · 봉인 <time dateTime={row.sealedAt}>{formatDetailTime(row.sealedAt)}</time>
        {' · '}기록된 근거 {row.evidence.length ? row.evidence.map(kind => EVIDENCE[kind] ?? kind).join(', ') : '없음'}</li>)}</ul> : null}
    </>}
    <p className={note}>승격 가능 여부는 운영 CLI 판정(status)으로만 확인합니다. fence active 는 DR 준비 완료를 뜻하지 않습니다 — 복구·승격 리허설은 별도 검증입니다.</p>
  </section>;
}

function Hosts({ status }: { status: Snapshot }) {
  const { runtime } = status, owned = status.owners.filter(row => row.instanceId !== null);
  const free = status.owners.filter(row => row.instanceId === null), unmapped = owned.filter(row => row.host === null);
  return <section className="mt-4" aria-labelledby="pipeline-hosts-title">
    <h3 id="pipeline-hosts-title" className="text-[13px] font-semibold">host별 실행 상태</h3>
    <p className={note}>역할 lease·준비조건(PR10d anchor 포함)·예산 장부는 서로 다른 관측입니다. host 는 batch 정책의 설정 매핑이며 하드웨어 확인 증거가 아닙니다.</p>
    <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{status.hosts.map(host => {
      const leases = owned.filter(row => row.host === host.host), ledger = runtime.ledgers.find(row => row.host === host.host)?.ledger;
      const unknown = host.roles.every(row => row.reason === 'readback_unknown');
      return <section key={host.host} className="min-w-0 rounded-[10px] border border-line p-3" aria-label={`${HOSTS[host.host] ?? host.host} 실행 상태`}>
        <h4 className="text-[13px] font-semibold">{HOSTS[host.host] ?? host.host}</h4>
        <p className="mt-1 text-[13px] font-medium">역할 lease</p>
        {leases.length ? <ul className="space-y-0.5 text-[13px] text-fg-2">{leases.map(row => <li key={row.role} className="break-words">
          {roleLabel(row.role)} · <span className="font-mono">{row.instanceId}</span> · 릴리스 <span className="font-mono" title={row.release ?? undefined}>{short(row.release)}</span>
          {' · '}epoch {number(row.epoch)} · {row.live === null ? '미확인' : row.live ? '유효' : '기한 지남'}</li>)}</ul>
          : <p className="text-[13px] text-fg-3">{runtime.ownersRead ? '이 host 에 매핑된 lease 없음' : '자료 없음'}</p>}
        <div className="mt-2">{ledger ? <Ledger ledger={ledger} /> : <p className={note}>자료 없음</p>}</div>
        <details className="mt-2">
          <summary className="cursor-pointer text-[13px] font-medium">준비조건 · {unknown ? '자료 없음' : `확인 ${host.roles.filter(row => row.ready).length}/${host.roles.length}`}</summary>
          <ul className="mt-1 space-y-0.5 text-[13px] text-fg-2">{host.roles.map(role => <li key={role.role}>{roleLabel(role.role)} · {REASONS[role.reason] ?? '미확인'}
            {' · '}{anchorLabel(runtime.anchors.find(row => row.host === host.host && row.role === role.role)?.anchor ?? null)}</li>)}</ul>
        </details>
      </section>;
    })}</div>
    {unmapped.length ? <p className="mt-2 break-words text-[13px] text-fg-2">host 미확인 lease · {unmapped.map(row =>
      `${roleLabel(row.role)} ${row.instanceId} (epoch ${number(row.epoch)}, ${row.live === null ? '미확인' : row.live ? '유효' : '기한 지남'})`).join(' · ')}</p> : null}
    {free.length ? <p className={note}>소유자 없는 역할 · {free.map(row => roleLabel(row.role)).join(', ')}</p> : null}
    {!status.owners.length && <p className={note}>역할 lease 자료 없음</p>}
    <p className={note}>예산 장부의 한도(CPU·RSS·heartbeat)는 각 host 설정에만 있어 이 화면은 압박 판정을 하지 않고 관측값만 보입니다.</p>
  </section>;
}

function Models({ models }: { models: Runtime['models'] }) {
  return <section className="mt-4" aria-labelledby="pipeline-models-title">
    <h3 id="pipeline-models-title" className="text-[13px] font-semibold">모델 슬롯 (provider budget)</h3>
    {models === null ? <p className={note}>자료 없음</p> : !models.length ? <p className={note}>정책 budget·대기·점유 요청 없음</p>
      : <ScrollTable label="provider budget별 모델 슬롯"><table className="mt-2 w-full min-w-[640px] text-left text-[13px]">
        <thead className="text-fg-3"><tr><th className="py-1">budget</th><th>설정 상한</th><th>점유</th><th>대기</th><th>최장 대기</th><th>예약 (기한 지남)</th>
          <th>dispatched</th><th>indeterminate</th><th>최장 미정산</th></tr></thead>
        <tbody>{models.map(row => <tr key={row.budget} className="border-t border-line"><th className="break-words py-2 font-mono font-medium">{row.budget}</th>
          <td>{number(row.limit)}</td><td>{number(row.reserved + row.dispatched + row.indeterminate)}</td><td>{number(row.waiting)}</td>
          <td>{row.oldestWaitingMin === null ? '—' : `${number(row.oldestWaitingMin)}분`}</td><td>{number(row.reserved)} ({number(row.expiredReserved)})</td>
          <td>{number(row.dispatched)}</td><td>{number(row.indeterminate)}</td>
          <td>{row.dispatched + row.indeterminate === 0 ? '—' : row.oldestUnsettledMin === null ? '미확인' : `${number(row.oldestUnsettledMin)}분`}</td></tr>)}</tbody>
      </table></ScrollTable>}
    <p className={note}>dispatched·indeterminate 는 정산 근거가 올 때까지 슬롯 하나 전체(full C)를 차지합니다. 설정 상한은 정책값이며 실제 모델 제공용량을 인증하지 않습니다.</p>
  </section>;
}

function Oracle({ oracle }: { oracle: Runtime['oracle'] }) {
  return <section className="mt-4" aria-labelledby="pipeline-oracle-title">
    <h3 id="pipeline-oracle-title" className="text-[13px] font-semibold">Oracle gate 준비도 (preflight 요약)</h3>
    <p className="mt-1 text-[13px] text-fg-2">Oracle 역할 lease 유효 {number(oracle.liveLeases)} · 실행 허가는 이 화면에서 판정하지 않음</p>
    <ul className="mt-1 space-y-0.5 text-[13px]">{oracle.checks.map(row => <li key={row.key} className={row.status === 'rejected' ? 'text-down' : 'text-fg-2'}>
      {GATES[row.key] ?? row.key} · {STATUS[row.status]} · {GATE_REASONS[row.reason] ?? row.reason}</li>)}</ul>
    <ScrollTable label="Oracle 역할별 준비도"><table className="mt-2 w-full min-w-[620px] text-left text-[13px]">
      <thead className="text-fg-3"><tr><th className="py-1">역할</th><th>후보</th><th>DB 권한</th><th>HTTP</th><th>모델</th><th>준비조건</th><th>PR10d</th><th>lease</th></tr></thead>
      <tbody>{oracle.roles.map(row => <tr key={row.role} className="border-t border-line"><th className="py-2 font-medium">{roleLabel(row.role)}</th>
        <td>{row.candidate === null ? '미확인' : row.candidate ? '있음' : '없음'}</td>
        {[row.db, row.http, row.model].map((value, index) => <td key={index}>{value === null ? '기록 없음' : CAPABILITY[value] ?? '미확인'}</td>)}
        <td>{row.reason === null ? '미확인' : REASONS[row.reason] ?? '미확인'}</td><td>{anchorLabel(row.anchor)}</td>
        <td>{row.lease === null ? '미확인' : row.lease ? '유효' : '없음'}</td></tr>)}</tbody>
    </table></ScrollTable>
    <p className={note}>권한·HTTP·모델은 운영자 canary attest 기록입니다. release 설치·runtime·cgroup 예산·OCI identity·DB 세션 timeout 은 Oracle host launcher 에서만 확인합니다(이 화면 미확인). 번역 역할은 모델 결합 근거가 있어야 준비됩니다.</p>
  </section>;
}

/** 읽기 전용 관측. 실행 제어·활성화 수단이 없다 */
export function PipelineRuntimeStatus({ status }: { status: Snapshot }) {
  return <><Dr dr={status.runtime.dr} /><Hosts status={status} /><Models models={status.runtime.models} /><Oracle oracle={status.runtime.oracle} /></>;
}
