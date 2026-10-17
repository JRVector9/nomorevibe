import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { MAX_SECOND_REVIEW_FAILURES, SECOND_REVIEW_RETRY_MS, SECOND_REVIEW_TRANSIENT_ERRORS, TRANSIENT_RETRY_MS } from '@/lib/crawl/second-review';
import { logger } from '@/lib/observability/logger';

/**
 * PR13c 관리자 처리 지표 — 최근 1시간·24시간의 고유 완료·실제 호출·재사용·AI2 표를 단계별로 나눠 읽는다(읽기 전용).
 *
 * 측정 도구(pipeline-capacity-live)와의 대응:
 * - AI1 호출·실패·취소·규칙 종료·재사용·대체는 reportLiveCapacityWindow 의 calls.ai1 / exclusions 와 같은 순서·같은 조건이다
 *   (자동 시도만, rules → 재사용 → superseded → running 제외 → cancelled|deferred 실패는 취소 → 나머지 성공·실패가 호출).
 *   측정 도구의 시각 이상(clockAnomalies)·현재 설정 identity(stale) 거르기는 하지 않는다.
 * - AI2 호출·실패·사슬·미귀속은 collectLiveCapacityWindow 의 ai2Calls 와 같은 경계다: 창 안에서 만든 fallback 사슬만
 *   확정하고(실패 수 max(failure_count) + 결정 난 행), 창 밖에서 시작한 사슬은 미귀속으로 따로 센다.
 * - AI1 고유 완료는 단계 수준이다: 창 안에서 모델 결정이 난 후보 수(후보마다 창 안 첫 성공을 골라 재심사 여부를 본다).
 *   측정 도구의 최종 고유 완료(finals.newCandidates — 승인은 AI2 칸 규칙까지)는 이 화면에서 계산하지 않는다(DEFERRED 참조).
 * 모델 장부(model_capacity_events)의 dispatch·정산은 도메인 기록과 겹칠 수 있어 더하지 않고 따로 보인다.
 *
 * 조회 비용: 시각 열 인덱스가 없는 append 표(crawl_review_attempts·second_reviews·model_capacity_events)는 PK 역방향 스캔으로
 * '24시간+여유 이전에 시작한 마지막 행'의 id 를 찾아 그 뒤만 읽는다. 나머지는 상태·시각 인덱스(crawl_frontier_dequeue_idx,
 * crawl_candidates_state_idx, second_reviews_status_idx, crawl_publication_changes_time_idx, model_capacity_requests_waiting_idx/
 * active_idx)만 쓴다. 인덱스로 창을 자를 수 없는 집계는 DEFERRED 로 남기고 화면에 '미계산'으로 보인다.
 */
export const COMPLETION_WINDOWS = ['1h', '24h'] as const;
export type CompletionWindow = typeof COMPLETION_WINDOWS[number];
/** 시작 → 종료 간격이 이보다 길면 PK 경계 밖이라 세지 않는다. AI1 gateway 기한 60초·재시도 유예 30분보다 넉넉하다 */
export const SCAN_MARGIN_HOURS = 1;
const LEDGER_CLASSES = ['first', 'second', 'background'] as const;

export type CellState = 'value' | 'unknown' | 'deferred' | 'none';
export type WindowMetric = { key: string; label: string; state: CellState; values: Record<CompletionWindow, number> | null; note: string | null };
export type QueueMetric = { key: string; label: string; state: CellState; count: number | null; oldestMin: number | null; aged: boolean; note: string | null };
export type StageKey = 'fetch' | 'ai1' | 'ai2' | 'publish' | 'background';
export type StageCompletions = { key: StageKey; label: string; metrics: WindowMetric[]; queue: QueueMetric[] };
export type PipelineCompletions = { observedAt: string | null; stages: StageCompletions[] };

/** 이 화면에서 세지 않는 것과 이유·설계(주기 계산/캐시). 구현하지 않았다 */
export const DEFERRED = [
  { key: 'final', label: '최종 고유 완료(측정 도구 정의)', reason: '승인은 현재 AI2 칸마다 승인 표가 있어야 최종이다. 적체된 옛 승인까지 표·설정 identity 를 모두 읽어야 해 창 인덱스로 자를 수 없다.',
    design: '주기 작업(예: 5분)이 복제본에서 collectLiveCapacityWindow(1h·24h)를 돌려 report 요약(finals·exclusions·calls)을 operations_observations 에 남기고, 화면은 관측 나이와 함께 읽는다.' },
  { key: 'fetch', label: '원본 수집 고유 완료', reason: 'crawl_documents.fetched_at·crawl_frontier.updated_at 에 시각 인덱스가 없고 다시 수집하면 행을 덮어쓴다.',
    design: 'fetched_at 인덱스(migration) 또는 수집 writer 의 append 기록, 아니면 위 주기 작업에 함께 집계.' },
  { key: 'background', label: '배경 작업 도메인 완료·legacy 호출', reason: '번역·소개·키워드 표마다 시각 열과 호출 기록이 달라 공통 인덱스 경로가 없다.',
    design: '모델 장부가 열린 경로는 장부 정산으로 대신 보이고, legacy 는 주기 집계로만 센다.' },
  { key: 'ready', label: 'AI1·발행 실행 가능 대기', reason: '후보 선택·발행 조건 predicate 가 무겁다.', design: '같은 화면 파이프라인 카드의 1분 집계(실행 가능 대기)를 본다.' },
] as const;

const count = z.number().int().nonnegative().safe();
const at = z.iso.datetime({ offset: true });
const pair = <T extends z.ZodTypeAny>(row: T) => z.object({ '1h': row, '24h': row }).strict();
/** 1시간 창은 24시간 창의 부분집합이다. 거꾸로 나오면 그 구획을 믿지 않는다 */
function nested<T extends Record<string, number>>(windows: Record<CompletionWindow, T>, keys: (keyof T)[]) {
  return keys.every(key => windows['1h'][key] <= windows['24h'][key]);
}
const ai1Window = z.object({ calls: count, failed: count, cancelled: count, rules: count, reuse: count, superseded: count,
  succeeded: count, handoff: count, unique: count, uniqueNew: count }).strict()
  .refine(row => row.failed <= row.calls && row.succeeded <= row.calls && row.handoff <= row.succeeded
    && row.unique <= row.succeeded && row.uniqueNew <= row.unique);
const ai1Schema = z.object({ windows: pair(ai1Window), backoff: count, human: count, humanOldestAt: at.nullable() }).strict()
  .refine(row => nested(row.windows, ['calls', 'failed', 'cancelled', 'rules', 'reuse', 'superseded', 'succeeded', 'handoff', 'unique', 'uniqueNew']));
const ai2Window = z.object({ chains: count, calls: count, failed: count, votes: count, votedCandidates: count, unattributed: count }).strict()
  .refine(row => row.failed <= row.calls && row.votes <= row.calls && row.votedCandidates <= row.votes);
const ai2Schema = z.object({ windows: pair(ai2Window), ready: count, readyOldestAt: at.nullable(), backoff: count,
  human: count, humanCandidates: count, humanOldestAt: at.nullable() }).strict()
  .refine(row => nested(row.windows, ['chains', 'calls', 'failed', 'votes', 'votedCandidates']) && row.humanCandidates <= row.human);
const publishWindow = z.object({ published: count, transitions: count, withdrawn: count }).strict().refine(row => row.published <= row.transitions);
const publishSchema = z.object({ windows: pair(publishWindow), approved: count }).strict()
  .refine(row => nested(row.windows, ['published', 'transitions', 'withdrawn']));
const fetchSchema = z.object({ ready: count, readyOldestAt: at.nullable(), backoff: count, inFlight: count, human: count, humanOldestAt: at.nullable() }).strict();
const ledgerWindow = z.object({ dispatched: count, settled: count, indeterminate: count, released: count, settledUnits: count }).strict()
  .refine(row => row.settledUnits <= row.settled);
const ledgerClass = z.object({ windows: pair(ledgerWindow), waiting: count, waitingOldestAt: at.nullable(), active: count }).strict()
  .refine(row => nested(row.windows, ['dispatched', 'settled', 'indeterminate', 'released', 'settledUnits']));
const ledgerSchema = z.object({ first: ledgerClass, second: ledgerClass, background: ledgerClass }).strict();

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function minutes(now: string, since: string | null) {
  if (since === null) return null;
  const age = Math.floor((Date.parse(now) - Date.parse(since)) / 60_000);
  return Number.isFinite(age) && age >= 0 ? age : null;
}
const metric = (key: string, label: string, note: string | null = null): WindowMetric => ({ key, label, state: 'unknown', values: null, note });
const fixed = (key: string, label: string, state: 'deferred' | 'none', note: string): WindowMetric => ({ key, label, state, values: null, note });
const queue = (key: string, label: string, aged: boolean, note: string | null = null): QueueMetric =>
  ({ key, label, state: 'unknown', count: null, oldestMin: null, aged, note });
const queueFixed = (key: string, label: string, state: 'deferred' | 'none', note: string): QueueMetric =>
  ({ key, label, state, count: null, oldestMin: null, aged: false, note });
const ledgerMetrics = (): WindowMetric[] => [metric('ledgerDispatched', '모델 장부 dispatch', '실제 호출 시작 기록'),
  metric('ledgerSettled', '모델 장부 정산', '종료 근거로 정산'), metric('ledgerIndeterminate', '모델 장부 불명', '외부 종료 미확인'),
  metric('ledgerReleased', '모델 장부 회수', '종료 근거로 슬롯 회수')];
const NOT_MODEL = '모델 호출 단계 아님';
const NO_REUSE = '재사용 기록 열 없음';

function empty(): StageCompletions[] {
  return [
    { key: 'fetch', label: '원본 수집', metrics: [fixed('unique', '고유 완료', 'deferred', '시각 인덱스 없음 · 주기 집계 필요'),
      fixed('calls', '실제 모델 호출', 'none', NOT_MODEL), fixed('reuse', '재사용', 'none', NOT_MODEL)],
    queue: [queue('ready', '실행 가능', true, '준비 시각 기준'), queue('backoff', '재시도 예약', false), queue('inFlight', '가져오는 중', false),
      queue('human', '사람 확인', true, '원본 갱신 실패·저장소 삭제 · 마지막 변경 기준')] },
    { key: 'ai1', label: 'AI 1차', metrics: [metric('unique', '고유 완료(후보)', '창 안 모델 결정 후보'), metric('reReview', '그중 재심사'),
      metric('repeat', '반복 세대', '같은 후보의 추가 결정'), metric('handoff', '사람 인계 결정', 'needs_review 결정'),
      metric('calls', '실제 호출 · 도메인 기록', 'legacy 포함 성공+기술 실패'), metric('failed', '그중 기술 실패'),
      metric('cancelled', '취소·연기', '호출 수에서 뺌'), ...ledgerMetrics(), metric('reuse', '재사용', '이전 결과 복사 · 호출 아님'),
      metric('rules', '규칙 종료', '모델 미호출'), metric('superseded', '대체됨', '소유권 변경·관리자 결정')],
    queue: [queueFixed('ready', '실행 가능', 'deferred', '파이프라인 카드의 1분 집계'), queue('backoff', '재시도 유예', false, '최근 시도가 유예 중인 실패'),
      queue('human', '사람 확인', true, '시도 소진 · 마지막 변경 기준'), queue('slotWaiting', '모델 슬롯 대기', true), queue('slotActive', '모델 슬롯 점유', false)] },
    { key: 'ai2', label: 'AI 2차', metrics: [metric('unique', '표 받은 후보(고유)', '관문 완료 아님'), metric('votes', 'AI2 표', '결정 난 표'),
      metric('calls', '실제 호출 · 도메인 기록', '창 안에서 만든 사슬만'), metric('failed', '그중 기술 실패'),
      metric('unattributed', '경계 걸친 사슬', '창 밖에서 시작 · 미귀속'), ...ledgerMetrics(), fixed('reuse', '재사용', 'none', NO_REUSE)],
    queue: [queue('ready', '대기(심사 중 포함)', true, '재시도 가능 시각 기준'), queue('backoff', '재시도 예약', false),
      queue('human', '사람 확인 표', true, '결정 기준'), queue('slotWaiting', '모델 슬롯 대기', true), queue('slotActive', '모델 슬롯 점유', false)] },
    { key: 'publish', label: '발행', metrics: [metric('unique', '고유 완료(저장소)', '발행으로 바뀐 저장소'), metric('transitions', '발행 전환', '같은 저장소 반복 포함'),
      metric('withdrawn', '내림', '발행 해제된 저장소'), fixed('calls', '실제 모델 호출', 'none', NOT_MODEL)],
    queue: [queue('approved', '승인 상태(발행 전)', false, '관문·분류 조건 판정 전'), queueFixed('ready', '실행 가능', 'deferred', '파이프라인 카드의 1분 집계')] },
    { key: 'background', label: '배경 작업', metrics: [fixed('unique', '고유 완료(도메인)', 'deferred', '표마다 시각 열이 달라 주기 집계 필요'),
      metric('settledUnits', '장부 정산 작업 단위', '같은 작업의 반복 정산은 한 번'), fixed('calls', '실제 호출 · 도메인 기록', 'deferred', 'legacy 호출 기록 없음'),
      ...ledgerMetrics(), fixed('reuse', '재사용', 'none', NO_REUSE)],
    queue: [queue('slotWaiting', '모델 슬롯 대기', true), queue('slotActive', '모델 슬롯 점유', false)] },
  ];
}

/** 표시 전용. 읽지 못했거나 앞뒤가 맞지 않는 구획은 0 이 아니라 미확인으로 둔다 */
export function buildPipelineCompletions(raw: unknown): PipelineCompletions {
  const input = record(raw), clock = at.safeParse(input.at);
  const result: PipelineCompletions = { observedAt: clock.success ? clock.data : null, stages: empty() };
  if (!clock.success) return result;
  const now = clock.data;
  const stage = (key: StageKey) => result.stages.find(row => row.key === key)!;
  const fill = (key: StageKey, name: string, values: Record<CompletionWindow, number>) =>
    Object.assign(stage(key).metrics.find(row => row.key === name)!, { state: 'value', values });
  const fillQueue = (key: StageKey, name: string, value: number, oldestAt: string | null = null) =>
    Object.assign(stage(key).queue.find(row => row.key === name)!, { state: 'value', count: value, oldestMin: value ? minutes(now, oldestAt) : null });
  const by = <T>(windows: Record<CompletionWindow, T>, pick: (row: T) => number) =>
    ({ '1h': pick(windows['1h']), '24h': pick(windows['24h']) });

  const ai1 = ai1Schema.safeParse(input.ai1);
  if (ai1.success) {
    const { windows } = ai1.data;
    fill('ai1', 'unique', by(windows, row => row.unique)); fill('ai1', 'reReview', by(windows, row => row.unique - row.uniqueNew));
    fill('ai1', 'repeat', by(windows, row => row.succeeded - row.unique)); fill('ai1', 'handoff', by(windows, row => row.handoff));
    for (const name of ['calls', 'failed', 'cancelled', 'reuse', 'rules', 'superseded'] as const) fill('ai1', name, by(windows, row => row[name]));
    fillQueue('ai1', 'backoff', ai1.data.backoff); fillQueue('ai1', 'human', ai1.data.human, ai1.data.humanOldestAt);
  }
  const ai2 = ai2Schema.safeParse(input.ai2);
  if (ai2.success) {
    const { windows } = ai2.data;
    fill('ai2', 'unique', by(windows, row => row.votedCandidates));
    for (const name of ['votes', 'calls', 'failed', 'unattributed'] as const) fill('ai2', name, by(windows, row => row[name]));
    fillQueue('ai2', 'ready', ai2.data.ready, ai2.data.readyOldestAt); fillQueue('ai2', 'backoff', ai2.data.backoff);
    fillQueue('ai2', 'human', ai2.data.human, ai2.data.humanOldestAt);
    stage('ai2').queue.find(row => row.key === 'human')!.note = `후보 ${ai2.data.humanCandidates.toLocaleString('ko-KR')} · 결정 기준`;
  }
  const publish = publishSchema.safeParse(input.publish);
  if (publish.success) {
    const { windows } = publish.data;
    fill('publish', 'unique', by(windows, row => row.published)); fill('publish', 'transitions', by(windows, row => row.transitions));
    fill('publish', 'withdrawn', by(windows, row => row.withdrawn)); fillQueue('publish', 'approved', publish.data.approved);
  }
  const fetch = fetchSchema.safeParse(input.fetch);
  if (fetch.success) {
    fillQueue('fetch', 'ready', fetch.data.ready, fetch.data.readyOldestAt); fillQueue('fetch', 'backoff', fetch.data.backoff);
    fillQueue('fetch', 'inFlight', fetch.data.inFlight); fillQueue('fetch', 'human', fetch.data.human, fetch.data.humanOldestAt);
  }
  const ledger = ledgerSchema.safeParse(input.ledger);
  if (ledger.success) for (const [key, name] of [['ai1', 'first'], ['ai2', 'second'], ['background', 'background']] as const) {
    const row = ledger.data[name];
    fill(key, 'ledgerDispatched', by(row.windows, value => value.dispatched)); fill(key, 'ledgerSettled', by(row.windows, value => value.settled));
    fill(key, 'ledgerIndeterminate', by(row.windows, value => value.indeterminate)); fill(key, 'ledgerReleased', by(row.windows, value => value.released));
    if (key === 'background') fill(key, 'settledUnits', by(row.windows, value => value.settledUnits));
    fillQueue(key, 'slotWaiting', row.waiting, row.waitingOldestAt); fillQueue(key, 'slotActive', row.active);
  }
  return result;
}

/**
 * 한 문장·한 DB 시계. 시간대 없는 열(UTC 벽시계)은 utc, timestamptz 열(모델 장부)은 at 과 비교한다.
 * 창 경계 스캔: max(id) WHERE 시작 시각 <= 지금-(24시간+여유) 는 PK 역방향 스캔으로 창 크기만큼만 읽고 멈춘다.
 */
export function pipelineCompletionsSql(): SQL {
  const span = sql.raw(`interval '${24 + SCAN_MARGIN_HOURS} hours'`);
  const transient = sql.join(SECOND_REVIEW_TRANSIENT_ERRORS.map(code => sql`${code}`), sql`, `);
  const classes = sql.raw(`(VALUES ${LEDGER_CLASSES.map(name => `('${name}')`).join(', ')}) k(class)`);
  const iso = (value: SQL) => sql`(${value}) AT TIME ZONE 'UTC'`;
  return sql`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at),
    u AS MATERIALIZED (SELECT at, at AT TIME ZONE 'UTC' AS utc FROM clock),
    w AS MATERIALIZED (SELECT * FROM (VALUES ('1h', interval '1 hour'), ('24h', interval '24 hours')) v(label, span)),
    ai1_rows AS MATERIALIZED (
      SELECT a.id, a.candidate_id, a.state, a.provider, a.reused_from_attempt_id, a.error_code, a.completed_at, a.retry_after,
        a.outcome->>'decision' AS decision
      FROM crawl_review_attempts a
      WHERE a.id > coalesce((SELECT max(f.id) FROM crawl_review_attempts f WHERE f.started_at <= (SELECT utc FROM u) - ${span}), 0)
        AND a.kind = 'automatic'),
    ai1_ended AS MATERIALIZED (
      SELECT w.label, r.id, r.candidate_id, r.state, r.decision, r.completed_at,
        CASE WHEN r.provider = 'rules' THEN 'rules' WHEN r.reused_from_attempt_id IS NOT NULL THEN 'reuse'
          WHEN r.state = 'superseded' THEN 'superseded' WHEN r.state = 'failed' AND r.error_code IN ('cancelled', 'deferred') THEN 'cancelled'
          WHEN r.state IN ('succeeded', 'failed') THEN 'call' END AS category
      FROM ai1_rows r CROSS JOIN w CROSS JOIN u WHERE r.completed_at > u.utc - w.span AND r.completed_at <= u.utc),
    -- 재심사: 측정 도구와 같이 이 후보의 앞선 자동 성공이 있는지(창 밖 포함). LATERAL LIMIT 1 로 후보별 인덱스 조회만 한다
    ai1_first AS MATERIALIZED (
      SELECT DISTINCT ON (e.label, e.candidate_id) e.label, e.candidate_id, prior.found IS NOT NULL AS re_review
      FROM ai1_ended e LEFT JOIN LATERAL (SELECT true AS found FROM crawl_review_attempts p WHERE p.candidate_id = e.candidate_id
        AND p.kind = 'automatic' AND p.state = 'succeeded' AND p.id < e.id LIMIT 1) prior ON true
      WHERE e.category = 'call' AND e.state = 'succeeded' ORDER BY e.label, e.candidate_id, e.completed_at, e.id),
    ai1_window AS (
      SELECT w.label, jsonb_build_object('calls', count(e.id) FILTER (WHERE e.category = 'call'),
        'failed', count(e.id) FILTER (WHERE e.category = 'call' AND e.state = 'failed'),
        'cancelled', count(e.id) FILTER (WHERE e.category = 'cancelled'), 'rules', count(e.id) FILTER (WHERE e.category = 'rules'),
        'reuse', count(e.id) FILTER (WHERE e.category = 'reuse'), 'superseded', count(e.id) FILTER (WHERE e.category = 'superseded'),
        'succeeded', count(e.id) FILTER (WHERE e.category = 'call' AND e.state = 'succeeded'),
        'handoff', count(e.id) FILTER (WHERE e.category = 'call' AND e.state = 'succeeded'
          AND e.decision IS DISTINCT FROM 'approve' AND e.decision IS DISTINCT FROM 'reject'),
        'unique', (SELECT count(*) FROM ai1_first f WHERE f.label = w.label),
        'uniqueNew', (SELECT count(*) FROM ai1_first f WHERE f.label = w.label AND NOT f.re_review)) AS value
      FROM w LEFT JOIN ai1_ended e ON e.label = w.label GROUP BY w.label),
    held AS (
      SELECT count(*) FILTER (WHERE c.reason IN ('source_refresh_failed', 'repo_deleted')) AS fetch,
        min(c.updated_at) FILTER (WHERE c.reason IN ('source_refresh_failed', 'repo_deleted')) AS fetch_oldest,
        count(*) FILTER (WHERE c.reason = 'ai_review_exhausted') AS ai1, min(c.updated_at) FILTER (WHERE c.reason = 'ai_review_exhausted') AS ai1_oldest
      FROM crawl_candidates c WHERE c.state = 'needs_review'),
    ai2_rows AS MATERIALIZED (
      SELECT g.id, coalesce(g.fallback_for_id, g.id) AS root_id, g.candidate_id, g.created_at, g.reviewed_at, g.failure_count, g.second_decision
      FROM second_reviews g
      WHERE g.id > coalesce((SELECT max(f.id) FROM second_reviews f WHERE f.created_at <= (SELECT utc FROM u) - ${span}), 0)),
    ai2_set AS (
      SELECT DISTINCT w.label, w.span, r.root_id FROM ai2_rows r CROSS JOIN w CROSS JOIN u
      WHERE r.created_at > u.utc - w.span AND r.created_at <= u.utc),
    ai2_chain AS MATERIALIZED (
      SELECT s.label, s.root_id, coalesce(o.created_at > u.utc - s.span, true)
          AND bool_and(m.created_at > u.utc - s.span AND (m.reviewed_at IS NULL OR m.reviewed_at <= u.utc)) AS contained,
        max(m.failure_count) AS failures, count(*) FILTER (WHERE m.second_decision IS NOT NULL) AS successes
      FROM ai2_set s CROSS JOIN u JOIN ai2_rows m ON m.root_id = s.root_id
      LEFT JOIN LATERAL (SELECT r.created_at FROM second_reviews r WHERE r.id = s.root_id LIMIT 1) o ON true
      GROUP BY s.label, s.root_id, s.span, o.created_at, u.utc),
    ai2_window AS (
      SELECT w.label, jsonb_build_object('chains', count(c.root_id) FILTER (WHERE c.contained),
        'calls', coalesce(sum(c.failures + c.successes) FILTER (WHERE c.contained), 0)::int,
        'failed', coalesce(sum(c.failures) FILTER (WHERE c.contained), 0)::int,
        'votes', coalesce(sum(c.successes) FILTER (WHERE c.contained), 0)::int,
        'votedCandidates', (SELECT count(DISTINCT m.candidate_id) FROM ai2_chain x JOIN ai2_rows m ON m.root_id = x.root_id
          WHERE x.label = w.label AND x.contained AND m.second_decision IS NOT NULL),
        'unattributed', count(c.root_id) FILTER (WHERE NOT c.contained)) AS value
      FROM w LEFT JOIN ai2_chain c ON c.label = w.label GROUP BY w.label),
    ai2_now AS (
      SELECT p.ready, p.ready_oldest, (SELECT count(*) FROM second_reviews g WHERE g.status = 'failed'
          AND g.failure_count < ${MAX_SECOND_REVIEW_FAILURES}) AS backoff, h.human, h.human_candidates, h.human_oldest
      FROM (SELECT count(*) AS ready, min(greatest(g.created_at, CASE WHEN g.error_code IS NOT NULL THEN g.reviewed_at + (CASE WHEN g.error_code IN (${transient})
          THEN ${TRANSIENT_RETRY_MS} ELSE ${SECOND_REVIEW_RETRY_MS} END)::integer * interval '1 millisecond' END)) AS ready_oldest
        FROM second_reviews g WHERE g.status = 'pending') p
      CROSS JOIN (SELECT count(*) AS human, count(DISTINCT g.candidate_id) AS human_candidates, min(coalesce(g.reviewed_at, g.created_at)) AS human_oldest
        FROM second_reviews g WHERE g.status = 'needs_human') h),
    pub_rows AS MATERIALIZED (
      SELECT p.repo, p.delta, p.occurred_at FROM crawl_publication_changes p
      WHERE p.occurred_at > (SELECT utc FROM u) - interval '24 hours' AND p.occurred_at <= (SELECT utc FROM u)),
    pub_window AS (
      SELECT w.label, jsonb_build_object('published', count(DISTINCT p.repo) FILTER (WHERE p.delta > 0),
        'transitions', count(p.repo) FILTER (WHERE p.delta > 0), 'withdrawn', count(DISTINCT p.repo) FILTER (WHERE p.delta < 0)) AS value
      FROM w CROSS JOIN u LEFT JOIN pub_rows p ON p.occurred_at > u.utc - w.span GROUP BY w.label),
    fetch_now AS (
      SELECT (SELECT count(*) FROM crawl_frontier f WHERE f.state = 'pending' AND f.next_attempt_at <= u.utc) AS ready,
        (SELECT min(f.next_attempt_at) FROM crawl_frontier f WHERE f.state = 'pending' AND f.next_attempt_at <= u.utc) AS ready_oldest,
        (SELECT count(*) FROM crawl_frontier f WHERE f.state = 'pending' AND f.next_attempt_at > u.utc) AS backoff,
        (SELECT count(*) FROM crawl_frontier f WHERE f.state = 'fetching') AS in_flight
      FROM u),
    -- 요청 표는 계속 쌓이므로 창 안 event 마다 PK 로 찾는다(LIMIT 1 이 해시 조인·전체 스캔을 막는다)
    ev_rows AS MATERIALIZED (
      SELECT e.kind, e.created_at, r.class, r.unit FROM model_capacity_events e
      CROSS JOIN LATERAL (SELECT q.class, coalesce(q.logical_work_key, q.work_key) AS unit FROM model_capacity_requests q
        WHERE q.request_id = e.request_id LIMIT 1) r
      WHERE e.id > coalesce((SELECT max(f.id) FROM model_capacity_events f WHERE f.created_at <= (SELECT at FROM u) - ${span}), 0)
        AND e.created_at > (SELECT at FROM u) - interval '24 hours'
        AND e.kind IN ('dispatch_started', 'dispatch_settled', 'dispatch_indeterminate', 'dispatch_released')),
    ledger_window AS (
      SELECT k.class, jsonb_object_agg(x.label, x.value) AS windows FROM ${classes} JOIN LATERAL (
        SELECT w.label, jsonb_build_object('dispatched', count(e.kind) FILTER (WHERE e.kind = 'dispatch_started'),
          'settled', count(e.kind) FILTER (WHERE e.kind = 'dispatch_settled'),
          'indeterminate', count(e.kind) FILTER (WHERE e.kind = 'dispatch_indeterminate'),
          'released', count(e.kind) FILTER (WHERE e.kind = 'dispatch_released'),
          'settledUnits', count(DISTINCT e.unit) FILTER (WHERE e.kind = 'dispatch_settled')) AS value
        FROM w CROSS JOIN u LEFT JOIN ev_rows e ON e.class = k.class AND e.created_at > u.at - w.span AND e.created_at <= u.at
        GROUP BY w.label) x ON true GROUP BY k.class),
    ledger_now AS (
      SELECT k.class, (SELECT count(*) FROM model_capacity_requests r WHERE r.state = 'waiting' AND r.class = k.class) AS waiting,
        (SELECT min(r.queued_at) FROM model_capacity_requests r WHERE r.state = 'waiting' AND r.class = k.class) AS waiting_oldest,
        (SELECT count(*) FROM model_capacity_requests r WHERE r.state IN ('reserved', 'dispatched', 'indeterminate') AND r.class = k.class) AS active
      FROM ${classes})
    SELECT jsonb_build_object('at', u.at,
      'ai1', jsonb_build_object('windows', (SELECT jsonb_object_agg(label, value) FROM ai1_window),
        -- 유예(최대 30분) 중인 실패는 경계 뒤에 있고, 그보다 늦은 시도도 id 가 더 커서 ai1_rows 안에 있다
        'backoff', (SELECT count(DISTINCT r.candidate_id) FROM ai1_rows r WHERE r.state = 'failed' AND r.retry_after > u.utc
          AND NOT EXISTS (SELECT 1 FROM ai1_rows n WHERE n.candidate_id = r.candidate_id AND n.id > r.id)),
        'human', h.ai1, 'humanOldestAt', ${iso(sql`h.ai1_oldest`)}),
      'ai2', (SELECT jsonb_build_object('windows', (SELECT jsonb_object_agg(label, value) FROM ai2_window), 'ready', q.ready,
        'readyOldestAt', ${iso(sql`q.ready_oldest`)}, 'backoff', q.backoff, 'human', q.human, 'humanCandidates', q.human_candidates,
        'humanOldestAt', ${iso(sql`q.human_oldest`)}) FROM ai2_now q),
      'publish', jsonb_build_object('windows', (SELECT jsonb_object_agg(label, value) FROM pub_window),
        'approved', (SELECT count(*) FROM crawl_candidates c WHERE c.state = 'approved')),
      'fetch', (SELECT jsonb_build_object('ready', f.ready, 'readyOldestAt', ${iso(sql`f.ready_oldest`)}, 'backoff', f.backoff,
        'inFlight', f.in_flight, 'human', h.fetch, 'humanOldestAt', ${iso(sql`h.fetch_oldest`)}) FROM fetch_now f),
      'ledger', (SELECT jsonb_object_agg(n.class, jsonb_build_object('windows', l.windows, 'waiting', n.waiting,
        'waitingOldestAt', n.waiting_oldest, 'active', n.active)) FROM ledger_now n JOIN ledger_window l ON l.class = n.class)
    ) AS snapshot FROM u CROSS JOIN held h`;
}

/** 복제본(밀리면 주 DB)의 읽기 전용 트랜잭션 한 문장. 잠금·쓰기·실행 권한 판단이 없다 */
export async function readPipelineCompletions(): Promise<PipelineCompletions> {
  const { db, onReplica } = await import('@/lib/db');
  try {
    const snapshot = await onReplica(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL jit = off`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const [row] = await tx.execute<{ snapshot: unknown }>(pipelineCompletionsSql());
      return row?.snapshot;
    }, { accessMode: 'read only' }));
    return buildPipelineCompletions(snapshot);
  } catch (error) {
    logger.warn('operations.pipeline_completions_unavailable', { errorName: error instanceof Error ? error.name : 'unknown' });
    return buildPipelineCompletions(null);
  }
}
