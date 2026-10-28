import type { KoreanDiscoveryStatus } from '@/lib/operations/korean-discovery-status';
import type { ReplicaRead } from '@/lib/operations/replica-hold';
import { replicaHoldText } from '@/lib/operations/replica-hold';
import { KoreanDiscoveryControls } from './KoreanDiscoveryControls';

const BLOCKERS: Record<string, string> = { disabled: '한국어 탐색 설정 꺼짐', collection_disabled: '전체 수집 설정 꺼짐', start_missing: '과거 탐색 시작일 미설정',
  principal_missing: 'Oracle 전용 DB 계정 미설치', queries_not_transferred: '활성 검색 조건이 아직 M3에서 전달되지 않음',
  heartbeat_unconfirmed: '90초 이내 Oracle 워커 생존 관측 없음', query_retry: '검색 오류 후 재시도 대기' };
const STATES = { disabled: '꺼짐', blocked: '켜짐 · 실행 조건 미충족', unconfirmed: '켜짐 · 실행 미확인', observed: '켜짐 · 워커 생존 관측' };
const date = (v: string | null) => v ? v.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '기록 없음';

export function KoreanDiscoveryStatusCard({ read }: { read: ReplicaRead<KoreanDiscoveryStatus> }) {
  if (!read.ok) return <section id="oracle-korean-discovery" className="dash-card dash-12" aria-label="Oracle 한국어 프로젝트 탐색">
    <div className="dash-card-h"><h2>Oracle 한국어 프로젝트 탐색</h2><strong>미확인</strong></div>
    <p>설정·실행 상태를 읽지 못했습니다 · {replicaHoldText(read.reason)}. 꺼짐이나 수집 0건을 뜻하지 않습니다.</p>
  </section>;
  const s = read.value;
  return <section id="oracle-korean-discovery" className="dash-card dash-12" aria-label="Oracle 한국어 프로젝트 탐색">
    <div className="dash-card-h"><h2>Oracle 한국어 프로젝트 탐색</h2><strong>{STATES[s.state]}</strong></div>
    <p className="text-[13px]">전체 기간의 한국어 후보를 찾고 README·설명을 확인합니다. AI 제작 근거와 1차 검수는 기존 공통 큐에서 별도로 처리합니다.</p>
    <p className="mt-2 text-[13px]">시작일 {date(s.startAt)} · 전용 DB 계정 {s.principalReady ? '설치됨' : '미설치'} · 활성 검색 조건 {s.activeQueries}개</p>
    <p className="text-[13px]">워커 생존 관측 {date(s.heartbeatAt)} · 마지막 탐색 회차 {date(s.tickAt)}</p>
    <p className="text-[13px]">판별·적재 대기 {s.pending.toLocaleString('ko-KR')}{s.pendingTruncated ? '+' : ''}건 · 오류 후 대기 검색 {s.queryErrors}개{s.queryErrors > 0 && ` · 다음 재시도 ${date(s.nextRetryAt)}`}</p>
    {s.blockers.length > 0 && <ul className="mt-2 text-[13px] text-fg-2">{s.blockers.map(reason => <li key={reason}>{BLOCKERS[reason]}</li>)}</ul>}
    <details className="mt-2 text-[13px]"><summary>설정된 한국어 검색 조건 {s.queries.length}개</summary><ul>{s.queries.map(q => <li key={q.label}>{q.label} · <code>{q.query}</code></li>)}</ul></details>
    <KoreanDiscoveryControls key={s.epoch} enabled={s.enabled} startAt={s.startAt} epoch={s.epoch} />
    <p className="mt-2 text-[12px] text-fg-3">DB 기준 {date(s.at)}. 켜짐과 생존 관측은 신규 수집 성공을 뜻하지 않습니다. 실제 요청·한국어 통과·신규 적재량은 크롤러 탭의 탐색 진척에서 확인합니다.</p>
  </section>;
}
