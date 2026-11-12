import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { isPausedJob } from "@/lib/jobs/status";
import { AI_TASKS } from "@/lib/llm/ai-tasks";
import { JOB_LABELS } from "./contracts";
import { formatKst } from "./console-tasks";
import { STATION_JOBS } from "./flow-response";
import { jobHealthThresholds } from "./job-health";
import { PIPELINE_STAGES } from "./stage-registry";

/**
 * 수집·작업 화면(2026-11-12 운영 콘솔 조각 4a)의 순수 모형 — DB 없이 시험한다.
 *
 * - 수집원: 프론티어 신호(crawl_frontier.signal)를 코드의 신호 정의로 묶는다. 이름·잡은 코드에서 온다(흐름의 탐색 칸 STATION_JOBS.discover ·
 *   검색 신호 라벨 discover.queries · 글 목록 수집원 · 한국어 발굴 신호). 어디에도 없는 신호는 「그 밖의 신호」 한 줄로 모은다.
 * - 깔때기: 7일 동안 찾은 저장소가 지금 어디에 있나(후보 상태) — 거절·사람 확인·승인 대기·공개, 나머지(아직 후보가 아님·심사 중).
 * - 주기 작업: 카탈로그 잡 중 모델(LLM)을 부르지 않는 것 — AI 작업 목록(lib/llm/ai-tasks.ts)의 대화·그림 작업 잡과 수집원 잡·heartbeat 를 뺀다.
 *   임베딩(제품 벡터)은 모델이지만 LLM 이 아니라 여기에(검색 묶음) 둔다.
 * - 상태는 읽은 사실만: 꺼짐 · 사람이 멈춤(누가·언제·사유) · 마지막 회차 오류 · 제 일 못 함(degraded) · 성공 끊김(운영센터 경보와 같은 문턱) · 정상.
 */

/** 공개까지 간 비율을 그리는 최소 7일 찾음 — 그보다 적으면 「자료 부족」 */
export const YIELD_MIN_FOUND = 20;

export type SignalStateRow = { signal: string; state: string; n7: number; n24: number };
export type FunnelCounts = { found: number; rejected: number; review: number; approved: number; published: number; other: number };
export type SourceKind = "github" | "show-hn" | "feed" | "korean" | "other";
export type FeedRuleView = {
  url: string; titlePrefix: string; link: { kind: "page-title"; titleClass: string; linkClass: string; bodyId: string | null } | { kind: "entry-link" };
  /** null = 글 목록 작업이 돌 때마다 */
  intervalMinutes: number | null; priority: number; enabled: boolean; requireEvidence: boolean; legacy: boolean; id: string;
};
export type SourceDef = { key: string; kind: SourceKind; label: string; how: string; job: string | null; signals: readonly string[]; enabled: boolean;
  feed: FeedRuleView | null };

export type SourceInputs = {
  queries: readonly { label: string; enabled: boolean }[];
  showHn: { enabled: boolean };
  /** 글 목록 수집원(첫 줄 Show GN) — lib/crawl/feed-sources.ts feedSources */
  feeds: readonly FeedRuleView[];
  feedNames: Readonly<Record<string, string>>;
  showHnSignal: string;
  koreanSignal: string;
};

const discoverLabel = (job: string) => STATION_JOBS.discover.find(row => row.job === job)?.label ?? JOB_LABELS[job] ?? job;

/** 수집원 정의 — GitHub 검색 · Show HN · 글 목록 수집원마다 · 한국어 프로젝트 */
export function sourceDefs(input: SourceInputs): SourceDef[] {
  return [
    { key: "github", kind: "github", label: discoverLabel("crawl-seed"), how: "검색 API", job: "crawl-seed",
      signals: input.queries.map(query => query.label), enabled: input.queries.some(query => query.enabled), feed: null },
    { key: "show-hn", kind: "show-hn", label: discoverLabel("hn-show-seed"), how: "글 목록(API)", job: "hn-show-seed",
      signals: [input.showHnSignal], enabled: input.showHn.enabled, feed: null },
    ...input.feeds.map(feed => ({ key: `feed-${feed.id}`, kind: "feed" as const, label: input.feedNames[feed.id] ?? feed.id, how: "글 목록(RSS)",
      job: "gn-show-seed", signals: [input.feedNames[feed.id] ?? feed.id], enabled: feed.enabled, feed })),
    { key: "korean", kind: "korean", label: discoverLabel("crawl-ko-apply"), how: "검색 API · 언어 확인", job: "crawl-ko-apply",
      signals: [input.koreanSignal], enabled: true, feed: null },
  ];
}

/** 후보 상태 → 깔때기 칸. 후보가 아직 없거나(none) 심사 중(new)이면 「그 밖」 */
export function funnelOf(rows: readonly Pick<SignalStateRow, "state" | "n7">[]): FunnelCounts {
  const out: FunnelCounts = { found: 0, rejected: 0, review: 0, approved: 0, published: 0, other: 0 };
  for (const row of rows) {
    out.found += row.n7;
    if (row.state === "rejected") out.rejected += row.n7;
    else if (row.state === "needs_review") out.review += row.n7;
    else if (row.state === "approved") out.approved += row.n7;
    else if (row.state === "published") out.published += row.n7;
    else out.other += row.n7;
  }
  return out;
}

/** 공개까지 간 비율(%) — 7일 찾음이 YIELD_MIN_FOUND 보다 적으면 null(자료 부족) */
export const yieldPercent = (funnel: Pick<FunnelCounts, "found" | "published">): number | null =>
  funnel.found < YIELD_MIN_FOUND ? null : funnel.published / funnel.found * 100;

export type SourceAggregate = { def: SourceDef; found24: number; funnel: FunnelCounts; yieldPct: number | null;
  /** 신호마다(GitHub 검색의 검색어별) 7일 찾음·공개 — 많이 찾은 것부터 */
  signals: { signal: string; found7: number; published7: number }[] };

/** 신호 × 후보 상태 줄 → 수집원마다. 정의에 없는 신호는 「그 밖의 신호」(있을 때만) */
export function aggregateSources(defs: readonly SourceDef[], rows: readonly SignalStateRow[]): SourceAggregate[] {
  const owner = new Map<string, string>();
  for (const def of defs) for (const signal of def.signals) if (!owner.has(signal)) owner.set(signal, def.key);
  const leftovers = [...new Set(rows.map(row => row.signal).filter(signal => !owner.has(signal)))];
  const all: SourceDef[] = leftovers.length ? [...defs, { key: "other", kind: "other", label: "그 밖의 신호", how: "—", job: null, signals: leftovers,
    enabled: true, feed: null }] : [...defs];
  return all.map(def => {
    const own = rows.filter(row => def.key === "other" ? leftovers.includes(row.signal) : owner.get(row.signal) === def.key);
    const funnel = funnelOf(own);
    const bySignal = new Map<string, { signal: string; found7: number; published7: number }>();
    for (const row of own) {
      const entry = bySignal.get(row.signal) ?? { signal: row.signal, found7: 0, published7: 0 };
      entry.found7 += row.n7;
      if (row.state === "published") entry.published7 += row.n7;
      bySignal.set(row.signal, entry);
    }
    return { def, found24: own.reduce((sum, row) => sum + row.n24, 0), funnel, yieldPct: yieldPercent(funnel),
      signals: [...bySignal.values()].sort((a, b) => b.found7 - a.found7 || a.signal.localeCompare(b.signal)) };
  });
}

// ── 잡 상태 ──────────────────────────────────────────────────────────────

export type JobView = { name: string; lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null; notBefore: string | null;
  nextScheduledAt: string | null; lockedAt: string | null };
export type PauseView = { job: string; actor: string; at: string; reason: string };
export type DegradedView = { job: string; code: string; detail: string | null; streak: number | null; since: string | null };
export type StatusTone = "ok" | "warn" | "bad" | "off";
export type JobStatus = { tone: StatusTone; label: string; why: string | null };

const date = (value: string | null | undefined) => value ? new Date(value) : null;

/** 잡 하나의 상태 — 읽은 사실만. enabled=false 는 설정에서 꺼진 것(수집원) */
export function jobStatus(input: { job: JobView | null; intervalMs: number | null; enabled?: boolean; pause?: PauseView | null; degraded?: DegradedView | null; now: number }): JobStatus {
  const { job, now } = input;
  if (input.enabled === false) return { tone: "off", label: "꺼짐", why: "설정에서 꺼져 있습니다" };
  if (job && isPausedJob({ notBefore: date(job.notBefore) }, now)) {
    const pause = input.pause;
    const days = pause ? Math.floor((now - Date.parse(pause.at)) / 86_400_000) : 0;
    return { tone: "bad", label: days >= 1 ? `${days}일째 멈춤` : "멈춤",
      why: pause ? `사람이 멈춤 · ${pause.actor} · ${formatKst(pause.at)} · ${pause.reason || "사유 없음"}` : "사람이 멈춤(누가 멈췄는지 기록을 찾지 못함)" };
  }
  if (job?.lastError) return { tone: "bad", label: "오류", why: `마지막 회차 오류 · ${job.lastError.slice(0, 160)}` };
  const degraded = input.degraded;
  if (degraded) return { tone: "warn", label: "제 일 못 함",
    why: `${degraded.code}${degraded.detail ? ` · ${degraded.detail}` : ""}${degraded.streak ? ` · 연속 ${degraded.streak}회` : ""}` };
  if (!job || (!job.lastRunAt && !job.lastSuccessAt)) return { tone: "off", label: "기록 없음", why: null };
  if (input.intervalMs !== null) {
    const success = job.lastSuccessAt ? Date.parse(job.lastSuccessAt) : null;
    if (success === null || now - success >= jobHealthThresholds(input.intervalMs).staleHoldMs)
      return { tone: "warn", label: "성공 끊김", why: success === null ? "성공한 기록이 없습니다" : null };
  }
  return { tone: "ok", label: "정상", why: null };
}

// ── 주기 작업 ────────────────────────────────────────────────────────────

export type CronGroup = "collect" | "search" | "upkeep";
export const CRON_GROUP_LABELS: Readonly<Record<CronGroup, string>> = { collect: "수집", search: "검색", upkeep: "공개 뒤 유지" };
/** 검색 묶음 — 의미 검색 벡터·검색 데이터 갱신·검색 데이터 점검(임베딩·재정렬 서버 상태를 같이 본다) */
const SEARCH_JOBS: readonly string[] = ["product-embedding", "product-search-refresh", "product-search-health"];
/** 수집 묶음에 더하는 것 — 제품 흐름 밖의 글 수집(HN·Bluesky 화제, AI 소식) */
const COLLECT_EXTRA_JOBS: readonly string[] = ["hn-talk", "bluesky-talk", "news-refresh"];
/** LLM(대화·그림) 작업의 잡 — 이 화면 밖(모델·단계 패널)에서 다룬다 */
export const LLM_JOBS: ReadonlySet<string> = new Set(AI_TASKS.filter(task => task.kind === "chat" || task.kind === "vision").flatMap(task => task.jobs));
/** 수집원 표가 다루는 잡 — 탐색 칸의 잡(GitHub 검색·Show HN·글 목록·한국어) */
export const SOURCE_JOBS: ReadonlySet<string> = new Set(STATION_JOBS.discover.map(row => row.job));

export type CronJobDef = { job: string; label: string; group: CronGroup; intervalMs: number | null };
const stageLabel = (job: string) => PIPELINE_STAGES.find(stage => stage.code === job || (stage.jobs.length === 1 && stage.jobs[0] === job))?.label ?? null;

/** 주기 작업 표의 줄 — 카탈로그 차례, 묶음마다 */
export function cronJobDefs(): CronJobDef[] {
  const review = new Set(PIPELINE_STAGES.filter(stage => stage.group === "review").flatMap(stage => stage.jobs));
  return JOB_CATALOG.filter(job => job.name !== "heartbeat" && !LLM_JOBS.has(job.name) && !SOURCE_JOBS.has(job.name)).map(job => ({
    job: job.name, label: stageLabel(job.name) ?? JOB_LABELS[job.name] ?? job.name, intervalMs: job.intervalMs,
    group: SEARCH_JOBS.includes(job.name) ? "search" as const : review.has(job.name) || COLLECT_EXTRA_JOBS.includes(job.name) ? "collect" as const : "upkeep" as const,
  })).sort((a, b) => (["collect", "search", "upkeep"] as const).indexOf(a.group) - (["collect", "search", "upkeep"] as const).indexOf(b.group));
}

// ── 화면 모형 ────────────────────────────────────────────────────────────

export type SourceRowView = {
  key: string; kind: SourceKind; label: string; how: string; job: string | null; enabled: boolean;
  /** 지금 읽는 주기 — 잡 주기(덮어쓰기 포함), 화면에서 더한 글 목록은 max(수집원 주기, 글 목록 작업 주기) */
  intervalMs: number | null; overridden: boolean;
  /** 그 수집원을 도는 잡의 주기(덮어쓰기 포함)와 코드 기본값 — 「주기 바꾸기」가 고치는 값(화면에서 더한 글 목록은 수집원 주기를 따로 고친다) */
  jobIntervalMs: number | null; jobDefaultMs: number | null;
  found24: number; funnel: FunnelCounts; yieldPct: number | null; bar: number;
  lastSuccessAt: string | null; status: JobStatus; signals: SourceAggregate["signals"]; feed: FeedRuleView | null;
  /** 화면에서 더한 글 목록 수집원이 마지막으로 피드를 읽은 시각(잡 커서) */
  readAt: string | null;
};
export type CronRowView = { job: string; label: string; group: CronGroup; intervalMs: number | null; defaultMs: number | null; overridden: boolean;
  lastSuccessAt: string | null; waiting: number | null; status: JobStatus; paused: boolean; notBefore: string | null; version: number };
export type ServerView = { name: string; ok: boolean; error: string | null };
export type SourcesViewInput = {
  checkedAt: string; defs: readonly SourceDef[];
  funnel: { rows: readonly SignalStateRow[]; measuredAt: string } | null;
  jobs: readonly JobView[] | null; pauses: readonly PauseView[] | null; degraded: readonly DegradedView[] | null;
  intervals: { overrides: Readonly<Record<string, number>>; revision: number } | null;
  waiting: Readonly<Record<string, number | null>> | null;
  embedding: { public: number; embedded: number } | null;
  servers: readonly { name: string; ok: boolean; error?: string }[] | null;
  versions: Readonly<Record<string, number>> | null;
  feedReads?: Readonly<Record<string, string>>;
};
export type SourcesView = { checkedAt: string; funnelAt: string | null; revision: number | null; sources: SourceRowView[];
  cron: { group: CronGroup; label: string; rows: CronRowView[]; servers: ServerView[] }[]; errors: string[] };

const catalogMs = (job: string | null) => job ? JOB_CATALOG.find(entry => entry.name === job)?.intervalMs ?? null : null;

export function buildSourcesView(input: SourcesViewInput): SourcesView {
  const now = Date.parse(input.checkedAt);
  const overrides = input.intervals?.overrides ?? {};
  const jobMs = (job: string | null) => job ? overrides[job] ?? catalogMs(job) : null;
  const jobOf = (name: string | null) => name ? input.jobs?.find(job => job.name === name) ?? null : null;
  const pauseOf = (name: string | null) => name ? input.pauses?.find(pause => pause.job === name) ?? null : null;
  const degradedOf = (name: string | null) => name ? input.degraded?.find(row => row.job === name) ?? null : null;
  const errors: string[] = [];
  if (!input.funnel) errors.push("신호 집계(7일 찾음·공개)를 읽지 못했습니다 — 숫자 칸은 비어 있습니다.");
  if (!input.jobs) errors.push("작업 상태(jobs)를 읽지 못했습니다.");
  if (!input.intervals) errors.push("운영 설정(runtime_settings)을 읽지 못해 주기를 코드 기본값으로 보이고, 이 화면에서 주기를 바꿀 수 없습니다.");

  const sources = aggregateSources(input.defs, input.funnel?.rows ?? []).map(({ def, found24, funnel, yieldPct, signals }) => {
    const base = jobMs(def.job);
    const intervalMs = def.feed && !def.feed.legacy && def.feed.intervalMinutes !== null && base !== null
      ? Math.max(def.feed.intervalMinutes * 60_000, base) : base;
    const job = jobOf(def.job);
    const status = def.key === "other" ? { tone: "off" as const, label: "—", why: null }
      : jobStatus({ job, intervalMs: base, enabled: def.enabled, pause: pauseOf(def.job), degraded: degradedOf(def.job), now });
    return { key: def.key, kind: def.kind, label: def.label, how: def.how, job: def.job, enabled: def.enabled, intervalMs,
      overridden: def.job !== null && overrides[def.job] !== undefined, jobIntervalMs: base, jobDefaultMs: catalogMs(def.job), found24, funnel, yieldPct, bar: yieldPct === null ? 0 : Math.min(100, yieldPct * 4),
      lastSuccessAt: job?.lastSuccessAt ?? null, status, signals, feed: def.feed,
      readAt: def.feed && !def.feed.legacy ? input.feedReads?.[def.feed.id] ?? null : null };
  });

  const defs = cronJobDefs();
  const cron = (["collect", "search", "upkeep"] as const).map(group => ({ group, label: CRON_GROUP_LABELS[group],
    rows: defs.filter(def => def.group === group).map(def => {
      const job = jobOf(def.job);
      const waiting = input.waiting?.[def.job] ?? (def.job === "product-embedding" && input.embedding ? Math.max(0, input.embedding.public - input.embedding.embedded) : null);
      let status = jobStatus({ job, intervalMs: jobMs(def.job), pause: pauseOf(def.job), degraded: degradedOf(def.job), now });
      if (def.job === "product-embedding" && status.tone === "ok" && input.embedding)
        status = { ...status, label: `${input.embedding.embedded.toLocaleString("ko-KR")}개 완료` };
      return { job: def.job, label: def.label, group, intervalMs: jobMs(def.job), defaultMs: def.intervalMs, overridden: overrides[def.job] !== undefined,
        lastSuccessAt: job?.lastSuccessAt ?? null, waiting, status, paused: !!job && isPausedJob({ notBefore: date(job.notBefore) }, now),
        notBefore: job?.notBefore ?? null, version: input.versions?.[def.job] ?? 0 };
    }),
    servers: group === "search" ? (input.servers ?? []).map(server => ({ name: server.name === "임베딩" ? "벡터 서버(임베딩)" : server.name === "재정렬" ? "재정렬 서버" : server.name,
      ok: server.ok, error: server.error ?? null })) : [] }));
  return { checkedAt: input.checkedAt, funnelAt: input.funnel?.measuredAt ?? null, revision: input.intervals?.revision ?? null, sources, cron, errors };
}
