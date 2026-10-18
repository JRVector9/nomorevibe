import { Panel } from '@/components/Panel';
import { formatDetailTime } from '@/lib/format/time';
import type { ModelRouteStatus } from '@/lib/operations/model-route-status';
import { replicaHoldText, type ReplicaRead } from '@/lib/operations/replica-hold';
import type { RouteStatus } from '@/lib/operations/pipeline-control';
import { ScrollTable } from '../components/ScrollTable';

const ROUTE_STATUS: Record<RouteStatus, string> = {
  serving: '계약 있음(serving)', no_contract: '계약 없음(no_contract)', unmapped: '슬롯 정책에 없음(unmapped)',
  admission_only: '자리 확인만(admission_only)', stage_legacy: '기존 방식 단계(stage_legacy)', unknown: '모름(unknown)', unused: '지금 안 씀(unused)',
};
const MODES: Record<string, string> = { legacy: '기존 방식(legacy)', draining: '비우는 중(draining)', items: '항목 처리(items)',
  versioned: '분리 방식(versioned)', disabled: '꺼짐(disabled)', open: '열림(open)' };
const STAGES: Record<string, string> = { ai1: 'AI 1차', ai2: 'AI 2차' };
const n = (value: number) => value.toLocaleString('ko-KR');
const mode = (value: string | null) => value === null ? '—' : MODES[value] ?? value;

/**
 * 모델 경로 계약 · 전환 진행(ops-v8 PR8) — 운영 CLI status 와 같은 readback·판정을 보기만 한다(lib/operations/model-route-status.ts).
 * 복제본에서만 읽고, 못 읽으면 까닭과 함께 "보류"다. 바꾸는 단추는 없다 — 전환은 운영 CLI 로만 한다.
 */
export function ModelRouteContracts({ status: read }: { status: ReplicaRead<ModelRouteStatus> }) {
  if (!read.ok) return (
    <Panel title="모델 경로 계약 · 전환 진행" actions={<span className="text-[13px] text-fg-3">새 · 보류</span>}>
      <p className="text-[13px] text-fg-2">보류 — {replicaHoldText(read.reason)}. 주 DB 로 넘기지 않습니다.</p>
    </Panel>
  );
  const status = read.value;
  const counts = (Object.keys(ROUTE_STATUS) as RouteStatus[]).map(key => [key, status.routes.filter(row => row.status === key).length] as const)
    .filter(([, count]) => count > 0);
  const { batch, capacity } = status;
  const batchLive = batch.liveJobs + batch.liveRoles + batch.liveItems + batch.liveSources;
  return (
    <Panel title="모델 경로 계약 · 전환 진행"
      actions={<span className="text-[13px] text-fg-3">새 · 기준 <time dateTime={status.at}>{formatDetailTime(status.at)}</time> (DB · 복제본)</span>}
      note="운영 CLI status 와 같은 판정입니다. 공통 모델 슬롯(capacity)이 열리면(open) 계약 있음·지금 안 씀 밖의 경로는 호출 전에 모두 미뤄집니다. env 모델 값은 이 웹 프로세스 기준이라 역할 워커와 다를 수 있습니다.">
      <p className="text-[13px] text-fg-2">{counts.map(([key, count]) => `${ROUTE_STATUS[key]} ${n(count)}`).join(' · ')}</p>
      <ScrollTable label="모델 경로 계약">
        <table className="mt-2 w-full min-w-[560px] text-left text-[13px]">
          <thead className="text-fg-3"><tr><th className="py-1 font-medium">경로(route)</th><th className="font-medium">제공자(provider)</th>
            <th className="font-medium">모델</th><th className="font-medium">계약</th></tr></thead>
          <tbody>{status.routes.map(row => <tr key={`${row.routeId}:${row.provider}:${row.model ?? ''}`} className="border-t border-line">
            <td className="py-1.5 font-mono">{row.routeId}</td><td className="font-mono">{row.provider}</td><td className="font-mono">{row.model ?? '—'}</td>
            <td className={row.status === 'serving' ? 'text-up' : row.status === 'unused' ? 'text-fg-3' : 'text-fg-2'}>{ROUTE_STATUS[row.status]}</td></tr>)}</tbody>
        </table>
      </ScrollTable>
      <h3 className="mt-4 text-[13px] font-semibold">단계 전환</h3>
      <ScrollTable label="단계 전환 진행">
        <table className="mt-2 w-full min-w-[640px] text-left text-[13px]">
          <thead className="text-fg-3"><tr><th className="py-1 font-medium">단계</th><th className="font-medium">방식</th><th className="font-medium">비우기 출발</th>
            <th className="font-medium">담당 차례(epoch)</th><th className="font-medium">처리 중</th><th className="font-medium">기한 지난 미정산</th>
            <th className="font-medium">기존 잡</th><th className="font-medium">소비자 생존(2분 안)</th></tr></thead>
          <tbody>{status.stages.map(row => <tr key={row.stage} className="border-t border-line">
            <th className="py-1.5 font-medium">{STAGES[row.stage] ?? row.stage}</th><td>{mode(row.mode)}</td><td>{mode(row.drainingFrom)}</td>
            <td className="font-mono">{n(row.epoch)}</td><td className="font-mono">{n(row.live)}</td><td className="font-mono">{n(row.unsettled)}</td>
            <td>{row.legacyJobLive ? '실행 중' : '쉼'}</td><td className={row.consumers === 0 ? 'text-down' : ''}>{row.consumers === 0 ? '없음' : `${n(row.consumers)}대`}</td></tr>)}</tbody>
        </table>
      </ScrollTable>
      <p className="mt-2 text-[13px] text-fg-2">작업 배치(batch) {mode(batch.mode)}{batch.drainingFrom ? ` · 비우기 출발 ${mode(batch.drainingFrom)}` : ''} · 담당 차례(epoch) {n(batch.epoch)}
        {' '}· 실행 중 작업 {n(batch.liveJobs)} · 역할 {n(batch.liveRoles)} · 항목 {n(batch.liveItems)} · 출처 {n(batch.liveSources)}
        {batch.mode === 'draining' && (batchLive > 0 ? ' — 모두 0이 되어야 전환을 마칠 수 있습니다' : ' — 비우기 끝, 전환을 마칠 수 있습니다')}</p>
      <p className="mt-1 text-[13px] text-fg-2">공통 모델 슬롯(capacity) {mode(capacity.mode)} · 옛 세대 점유 {n(capacity.oldGeneration)}</p>
    </Panel>
  );
}
