'use client';

import { JOB_CATALOG } from '@/lib/jobs/catalog';
import { JOB_LABELS, ROLE_LABELS } from '@/lib/operations/contracts';
import type { OperationJob } from './OperationsCenter';

/**
 * 한 후보가 발견에서 공개까지 지나는 순서.
 *
 * 이름순 표로는 무엇이 무엇을 먹여 주는지 알 수 없다. 실제 의존 순서대로 놓고, 각 작업이
 * 무엇을 만들어 다음 작업에 넘기는지를 함께 적는다 — 어디가 끊겼는지 그 자리에서 보인다.
 * 카탈로그에 없는 작업이 생겨도 빠지지 않도록 나머지는 뒤에 붙인다.
 */
const PIPELINE_ORDER = [
  'crawl-seed', 'hn-show-seed', 'crawl-fetch', 'agent-evidence-refresh',
  'crawl-judge', 'crawl-agent-review', 'second-review', 'reason-translate', 'crawl-publish',
  'uptime-ping', 'product-evidence-refresh', 'click-rollup', 'ranking-refresh', 'news-refresh',
];

/** 이 작업이 무엇을 읽어 무엇을 남기는지 */
const FLOW: Record<string, { reads: string; writes: string }> = {
  'crawl-seed': { reads: 'GitHub 검색', writes: '프론티어' },
  'hn-show-seed': { reads: 'Show HN', writes: '프론티어' },
  'crawl-fetch': { reads: '프론티어', writes: '원본 · 후보(new)' },
  'agent-evidence-refresh': { reads: '원본', writes: '개발 AI 근거' },
  'crawl-judge': { reads: '후보(new)', writes: '승인 · 보류 · 거부' },
  'crawl-agent-review': { reads: '보류', writes: 'AI 심사 기록' },
  'second-review': { reads: 'AI 판단 · 공개분 표본', writes: '2차 판단' },
  'reason-translate': { reads: '영어 심사 사유', writes: '한국어 번역' },
  'crawl-publish': { reads: '승인', writes: '카테고리 · 공개 제품' },
  'uptime-ping': { reads: '공개 제품', writes: '응답 기록' },
  'product-evidence-refresh': { reads: '공개 제품', writes: '외부 근거' },
  'click-rollup': { reads: '클릭 원천', writes: '일별 집계' },
  'ranking-refresh': { reads: '일별 집계', writes: '시즌 스냅샷' },
  'news-refresh': { reads: '공식 피드', writes: 'AI 소식' },
};

const time = (value: string | null) =>
  value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '기록 없음';

/** 다음 실행까지 남은 시간. 지났으면 "지금" */
function countdown(at: string | null): string {
  if (!at) return '예약 없음';
  const seconds = Math.round((new Date(at).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return '지금';
  if (seconds < 60) return `${seconds}초 후`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}분 후` : `${Math.round(minutes / 60)}시간 후`;
}

function tone(job: OperationJob): { badge: string; node: string; label: string } {
  if (job.lastError) return { badge: 'border-down/40 bg-down/10 text-down', node: 'border-down/40 bg-down/10 text-down', label: '실패' };
  if (job.requestedVersion > job.processedVersion) return { badge: 'border-accent/40 bg-accent-soft text-accent', node: 'border-accent bg-accent text-white', label: '대기 중' };
  if (!job.lastSuccessAt) return { badge: 'border-line bg-bg-soft text-fg-3', node: 'border-line bg-bg-card text-fg-3', label: '실행 기록 없음' };
  return { badge: 'border-up/40 bg-up/10 text-up', node: 'border-up/40 bg-up/10 text-up', label: '정상' };
}

export function JobTimeline({ jobs, onOpen }: { jobs: OperationJob[]; onOpen: (job: OperationJob) => void }) {
  const ordered = [
    ...PIPELINE_ORDER.map((name) => jobs.find((job) => job.name === name)).filter((job): job is OperationJob => !!job),
    ...jobs.filter((job) => job.name !== 'heartbeat' && !PIPELINE_ORDER.includes(job.name)),
  ];

  return (
    <section className="ops-panel">
      <div className="ops-row">
        <div>
          <h2>작업 흐름</h2>
          <p>한 후보가 발견에서 공개까지 지나는 순서 그대로입니다. 각 작업이 무엇을 읽어 무엇을 남기는지 함께 봅니다.</p>
        </div>
        <span className="ops-badge">{ordered.length}개 작업</span>
      </div>

      <ol className="mt-4 flex flex-col">
        {ordered.map((job, index) => {
          const catalog = JOB_CATALOG.find((entry) => entry.name === job.name);
          const flow = FLOW[job.name];
          const state = tone(job);
          return (
            <li key={job.name} className="grid grid-cols-[34px_minmax(0,1fr)] gap-x-3">
              <div className="flex flex-col items-center">
                <span className={`grid size-[26px] shrink-0 place-items-center rounded-full border-2 font-mono text-[13px] font-bold ${state.node}`}>
                  {index + 1}
                </span>
                {index < ordered.length - 1 && <span className="w-[2px] flex-1 bg-line" aria-hidden />}
              </div>

              <div className="mb-2 min-w-0 rounded-[11px] border border-line bg-bg-card p-3.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="text-[14px] font-bold">{JOB_LABELS[job.name] ?? job.name}</h3>
                  <code className="font-mono text-[13px] text-fg-3">{job.name}</code>
                  <span className={`ml-auto rounded-full border px-2 py-0.5 text-[13px] font-semibold ${state.badge}`}>{state.label}</span>
                </div>

                {flow && (
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-fg-2">
                    <span className="rounded border border-line bg-bg-soft px-1.5 py-0.5 font-mono text-[13px]">{flow.reads}</span>
                    <span className="text-fg-3">→</span>
                    <span className="rounded border border-line bg-bg-soft px-1.5 py-0.5 font-mono text-[13px]">{flow.writes}</span>
                  </p>
                )}

                <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-2 text-[13px] text-fg-3">
                  <span>주기 <b className="font-mono font-semibold text-fg-2">{catalog?.intervalMs ? `${catalog.intervalMs / 60_000}분` : '요청될 때'}</b></span>
                  <span>다음 <b className="font-mono font-semibold text-fg-2">{countdown(job.nextScheduledAt)}</b></span>
                  <span>마지막 성공 <b className="font-mono font-semibold text-fg-2">{time(job.lastSuccessAt)}</b></span>
                  <span>누적 <b className="font-mono font-semibold text-fg-2">{job.runs.toLocaleString('ko-KR')}회</b></span>
                  <button type="button" onClick={() => onOpen(job)} className="ml-auto underline">상세</button>
                </div>

                {job.lastError && (
                  <p className="mt-2 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-[13px] leading-[1.7] text-fg-2">
                    <b className="font-semibold text-down">마지막 오류</b> {job.lastError.slice(0, 300)}
                  </p>
                )}
                {!job.lastError && job.requestedVersion > job.processedVersion && (
                  <p className="mt-2 text-[13px] text-fg-3">
                    실행이 요청됐고 아직 처리되지 않았습니다 · 담당 {ROLE_LABELS[catalog?.role ?? ''] ?? catalog?.role}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
