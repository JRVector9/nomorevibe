import type { PipelineControlStatus as Snapshot } from '@/lib/operations/pipeline-control-status';
import { ROLE_LABELS } from '@/lib/operations/contracts';
import { formatDetailTime } from '@/lib/format/time';
import { ScrollTable } from '../components/ScrollTable';

const MODES: Record<string, string> = { disabled: '비활성 설정', legacy: '기존 배치', draining: '드레인 중',
  versioned: '분리 배치 설정', open: '신규 접수 설정', items: '항목 처리 설정', observing: '원시 관측 설정', gated: '판정 gate 설정' };
const HOSTS: Record<string, string> = { m3: 'M3', mini: 'mini', 'oracle-osaka-smoke': 'Oracle · Osaka' };
const STAGES: Record<string, string> = { fetch: '원본 수집', ai1: 'AI 1차', ai2: 'AI 2차' };
const REASONS: Record<string, string> = { readback_unknown: '자료 없음', candidate_missing: '실행 후보 없음',
  identity_mismatch: 'host·릴리스 불일치', capability_unknown: '권한·자원 미확인', capability_stale: '권한·자원 관측 오래됨',
  result_unknown: '실제 결과 없음', result_stale: '실제 결과 오래됨', result_unverified: '결과 readback 미확인', ready: '준비조건 확인' };
const number = (value: number | null) => value === null ? '미확인' : value.toLocaleString('ko-KR');
const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;

/** Server-rendered observations only: this component cannot change execution controls. */
export function PipelineControlStatus({ status }: { status: Snapshot }) {
  return <section className="dash-card dash-12" aria-labelledby="pipeline-control-title">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="pipeline-control-title" className="text-[15px] font-bold">파이프라인 제어 상태</h2>
      <span className="text-[12px] text-fg-3">{status.observedAt
        ? <>DB 조회 <time dateTime={status.observedAt}>{formatDetailTime(status.observedAt)}</time></>
        : '조회 시각 미확인'}</span>
    </div>
    <p className="mt-1 text-[13px] text-fg-3">DB 설정·장부 기록·실행 준비조건을 구분합니다. 설정만으로 실제 가동이나 처리 완료를 보증하지 않습니다.</p>
    <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
      {status.backlog.map(row => <div key={row.label}><dt className="text-fg-3">{row.label}</dt><dd className="font-mono font-semibold">{number(row.value)}</dd></div>)}
    </dl>
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {status.controls.map(row => <section key={row.key} className="rounded-[10px] border border-line p-3" aria-label={row.label}>
        <h3 className="text-[13px] font-semibold">{row.label} <span className="font-normal text-fg-2">· {row.mode ? MODES[row.mode] ?? '미확인' : '미확인'}</span></h3>
        <p className="mt-1 font-mono text-[12px] text-fg-3">epoch {number(row.epoch)} · revision {number(row.revision)}</p>
        <p className="text-[12px] text-fg-3">{row.policy === 'verified' ? '설정 hash 일치' : row.policy === 'unset' ? 'control 정책 hash 없음' : '설정 검증 미확인'}</p>
        {row.metrics.length ? <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">{row.metrics.map(metric => <div key={metric.label}>
          <dt className="text-fg-3">{metric.label}</dt><dd className="font-mono font-semibold">{number(metric.value)}</dd>
        </div>)}</dl> : <p className="mt-2 text-[12px] text-fg-3">자료 없음</p>}
        <p className="mt-2 text-[12px] text-fg-3">{row.note}</p>
      </section>)}
      <section className="rounded-[10px] border border-line p-3" aria-label="남은 검증">
        <h3 className="text-[13px] font-semibold">남은 검증</h3>
        <ul className="mt-2 space-y-1 text-[12px] text-fg-2">
          <li>모델 제공용량 C · 미확인</li><li>실측 처리율 R · 미확인</li>
          <li>host 전체 DB 예산 강제 · 미확인</li><li>Oracle 실행·장애복구 · 별도 검증 필요</li>
        </ul>
      </section>
    </div>
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      <div><h3 className="text-[13px] font-semibold">단계별 소유권</h3>
        <ScrollTable label="단계별 제어 상태"><table className="mt-2 w-full min-w-[420px] text-left text-[12px]">
          <thead className="text-fg-3"><tr><th className="py-1">단계</th><th>mode</th><th>epoch</th><th>writer 계약</th><th>유효 소유</th><th>기한 지난 미정산</th></tr></thead>
          <tbody>{status.stages.map(row => <tr key={row.stage} className="border-t border-line"><th className="py-2 font-medium">{STAGES[row.stage] ?? row.stage}</th>
            <td>{row.mode ? MODES[row.mode] ?? '미확인' : '미확인'}</td><td>{number(row.epoch)}</td><td>{number(row.contract)}</td><td>{number(row.live)}</td><td>{number(row.unsettled)}</td></tr>)}</tbody>
        </table></ScrollTable>
        <p className="mt-1 text-[12px] text-fg-3">기한이 지나도 외부 호출 종료나 처리 완료로 세지 않습니다.</p>
      </div>
      <div><h3 className="text-[13px] font-semibold">host별 역할 준비조건</h3>
        <p className="mt-1 text-[12px] text-fg-3">권한·고정 릴리스·최근 실제 결과의 기존 검증 판정입니다. 현재 가동과 DR 보장은 별개입니다.</p>
        {status.hosts.map(host => <details key={host.host} className="mt-2 rounded-[8px] border border-line p-2">
          <summary className="cursor-pointer text-[12px] font-medium">{HOSTS[host.host] ?? host.host} · {host.roles.every(row => row.reason === 'readback_unknown')
            ? '자료 없음' : `준비조건 확인 ${host.roles.filter(row => row.ready).length}/${host.roles.length}`}</summary>
          <ul className="mt-2 space-y-1 text-[12px] text-fg-2">{host.roles.map(role => <li key={role.role}>{roleLabel(role.role)} · {REASONS[role.reason] ?? '미확인'}</li>)}</ul>
        </details>)}
      </div>
    </div>
    <h3 className="mt-4 text-[13px] font-semibold">현재 역할 lease</h3>
    {status.owners.length ? <ScrollTable label="현재 역할 소유권"><table className="mt-2 w-full min-w-[620px] text-left text-[12px]">
      <thead className="text-fg-3"><tr><th className="py-1">역할</th><th>instance / 설정 host</th><th>릴리스</th><th>epoch</th><th>DB 기한</th></tr></thead>
      <tbody>{status.owners.map(row => <tr key={row.role} className="border-t border-line"><th className="py-2 font-medium">{roleLabel(row.role)}</th>
        <td>{row.instanceId ?? '소유 없음'} · {row.host ? HOSTS[row.host] ?? row.host : 'host 미확인'}</td><td>{row.release ?? '미확인'}</td><td>{number(row.epoch)}</td>
        <td>{row.live === null ? '미확인' : row.live ? '유효' : '유효 소유 없음'}</td></tr>)}</tbody>
    </table></ScrollTable> : <p className="mt-1 text-[12px] text-fg-3">자료 없음</p>}
    <p className="mt-2 text-[12px] text-fg-3">host 매핑은 운영 설정이며 하드웨어 확인 증거가 아닙니다. 읽기 관측은 실행 권한으로 사용하지 않습니다.</p>
  </section>;
}
