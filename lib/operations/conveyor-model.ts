import { humanBacklogged, type HumanQueueOverview } from "@/lib/crawl/human-queue";
import type { HourlySeries, HourPoint } from "./dashboard";
import type { PipelineFlow } from "./pipeline";
import type { SearchHealth } from "./search-health-model";
import type { ThroughputSnapshot, ThroughputStage } from "./throughput-model";
import type { ProgressReason, StageProgress } from "./worker-progress";
// 타입만 읽는다 — conveyor-llm.ts 는 서버에서만 계산하고(작업 목록·모델 이름표를 끌고 온다) 이 모듈은 클라이언트 묶음에도 들어간다
import type { LlmStationKey, StationLlm } from "./conveyor-llm";

/**
 * 전체 흐름(컨베이어) 한 장 — 탐색 → 검수 → 프로필 등록 → 발행 → 키워드 등록을 칸(station)으로 세운다.
 *
 * DB 를 읽지 않는 순수 함수다. 숫자는 운영센터가 이미 쓰는 읽기(처리량 pipelineThroughput · 24시간 흐름 pipelineFlow ·
 * 시간별 hourlyThroughput · 사람 몫 humanQueueOverview · 워커 진행 buildWorkerProgress · 검색 점검 관측)를 그대로 옮기고,
 * 새로 세는 것은 보류 사유별 수와 분류 보류 수뿐이다(conveyor.ts). 판정 규칙도 운영센터 레일(railTone)과 같다 —
 * 멈춤(stalled)·워커 경보는 막힘, 적체(backlog)는 쌓임, 일시 중지는 멈춤, 처리 중은 흐름.
 *
 * 하나 더하는 규칙: 2차가 표를 하나도 내지 못하면서 1차 승인 후보가 "2차 갈림"으로 보류에 빠지는 것은 2차 대기(second_reviews)
 * 에 남지 않아 처리량 판정이 "일감 없음"으로 본다(2026-11-02 실측 3,701건). 그 보류가 24시간 안에 늘었으면 2차 칸을 막힘·쌓임으로 올린다.
 */
export type BeltTone = "flow" | "slow" | "jam" | "stop" | "idle" | "unknown";
export type StationKey = "discover" | "fetch" | "judge" | "first" | "second" | "profile" | "publish" | "keywords";
export type PhaseKey = "explore" | "review" | "profile" | "publish" | "keywords";

export const PHASES: readonly { key: PhaseKey; label: string }[] = [
  { key: "explore", label: "탐색" },
  { key: "review", label: "검수" },
  { key: "profile", label: "프로필 등록" },
  { key: "publish", label: "발행" },
  { key: "keywords", label: "키워드 등록" },
];

/** 색만으로 뜻을 전하지 않는다 — 화면은 늘 이 글자와 아이콘을 같이 쓴다 */
export const TONE_LABELS: Record<BeltTone, string> = {
  flow: "흐름", slow: "쌓임", jam: "막힘", stop: "멈춤", idle: "일감 없음", unknown: "미확인",
};
const RANK: Record<BeltTone, number> = { unknown: 1, idle: 0, flow: 0, stop: 2, slow: 3, jam: 4 };

export type HoldChip = { reason: string; label: string; count: number; recent24h: number | null; href: string | null };
export type Fact = { label: string; value: string; tone?: "warn" | "bad" };
export type Link = { href: string; label: string };

export type Station = {
  key: StationKey; phase: PhaseKey; label: string;
  /** 이 칸이 하는 일 한 줄 */
  what: string;
  /** 지금 이 칸 앞에 쌓여 기다리는 수. 줄이 없는 칸(탐색)은 null */
  waiting: number | null;
  oldestMinutes: number | null;
  done5m: number | null; doneHour: number | null; done24h: number | null;
  unit: "건" | "표";
  /** 정시 단위 24칸(오래된 것부터) — 시간별 기록이 없는 칸은 null */
  spark: number[] | null;
  /** 처리 수가 무엇을 센 것인지 — 칸 이름과 다른 기록을 대신 쓸 때만("소개 지음"). 없으면 그 칸의 처리 */
  rateLabel?: string;
  tone: BeltTone; status: string;
  /** 막힘·쌓임의 까닭 — 쉬운 말 한 줄 */
  reason: string | null;
  /** 이 칸에서 사람 확인(보류)으로 빠진 것 */
  holds: HoldChip[];
  facts: Fact[];
  links: Link[];
  /** 지금 쓰는 모델(conveyor-llm.ts) — 모든 칸이 같은 자리에 답을 가진다: 모델·LLM 없음·확인 못함. 읽지 못했으면 null */
  llm: StationLlm | null;
};

export type HumanBox = {
  waiting: number; direct: number; agreed: number; awaitingSecond: number; awaitingAi: number;
  decided24h: number | null; oldestDays: number | null; in24h: number | null;
  tone: BeltTone; status: string; reason: string | null;
  llm: StationLlm | null;
};

export type FunnelRow = { key: string; label: string; value: number | null; unit: "건" | "표"; note?: string };

export type Conveyor = {
  measuredAt: string;
  /** 시간별 칸(spark)의 시작 시각(ISO, UTC) — 오래된 것부터 */
  hours: string[] | null;
  stations: Station[];
  human: HumanBox | null;
  /** 보류 전체(needs_review) · 거절 누적 · 공개 제품 */
  held: number | null; rejected: number | null; published: number | null; publishedHour: number | null;
  /** 가장 급한 칸 — 막힘이 쌓임보다 먼저, 같은 급이면 앞(위쪽) 칸 */
  bottleneck: StationKey | "human" | null;
  headline: { tone: BeltTone; title: string; detail: string };
  funnel: FunnelRow[];
  holdsByReason: (HoldChip & { station: StationKey | "human" })[];
  /** 끝 칸(공개)의 모델 답 — LLM 없음 */
  sinkLlm: StationLlm | null;
  /** 공개 후 제품 번역·소개 검수와 검수 사유 번역. 공개 전 프로필 준비의 병목으로 합치지 않는다. */
  supportLlm?: StationLlm | null;
};

export type ConveyorInputs = {
  now: string;
  enabled: boolean;
  throughput: ThroughputSnapshot | null;
  flow: PipelineFlow | null;
  hourly: HourlySeries | null;
  human: HumanQueueOverview | null;
  progress: { stages: Pick<StageProgress, "stage" | "reason" | "alarm">[]; liveness: { role: string; reason: string; alarm: boolean }[] } | null;
  search: SearchHealth | null;
  /** 보류(needs_review) 사유별 수와 그중 24시간 안에 바뀐 것 */
  holds: { reason: string; count: number; recent24h: number }[] | null;
  /** 거절 누적(rejected) */
  rejected: number | null;
  /** 분류가 정해지지 않아 발행을 기다리는 승인 후보 — 1시간마다 다시 분류한다 */
  classification: { held: number; nextRetryAt: string | null } | null;
  /** 탐색 소스 잡 */
  sources: { job: string; label: string; lastSuccessAt: string | null; paused: boolean; failing: boolean }[];
  /** 칸마다 지금 쓰는 모델(buildStationLlm). 없으면(읽지 못함) 모델 칸은 「확인 못함」 */
  models?: (Record<LlmStationKey | "sink", StationLlm> & { support?: StationLlm }) | null;
};

/** 보류 사유 → 그 사유를 만든 칸. 표에 없는 사유는 사람 심사 칸(규칙·근거로 못 가른 것)으로 센다 */
export const HOLD_STATION: Readonly<Record<string, StationKey>> = {
  source_refresh_failed: "fetch",
  repo_deleted: "fetch",
  ambiguous: "judge",
  suspected_spam: "judge",
  ai_evidence_pending: "judge",
  ai_evidence_insufficient: "judge",
  ai_evidence_not_found: "judge",
  repository_relationship_conflict: "judge",
  source_changed: "judge",
  ai_review_exhausted: "first",
  second_review_split: "second",
  second_review_split_qwen_reject: "second",
  no_description: "profile",
};

export const HOLD_LABELS: Readonly<Record<string, string>> = {
  source_refresh_failed: "원본 재수집 실패",
  repo_deleted: "저장소 삭제됨",
  ambiguous: "규칙으로 못 가름",
  suspected_spam: "스팸·악성 의심",
  ai_evidence_pending: "AI 개발 근거 대기",
  ai_evidence_insufficient: "AI 개발 근거 부족",
  ai_evidence_not_found: "개발 근거 미확인",
  repository_relationship_conflict: "제품·저장소 관계 충돌",
  source_changed: "발행 URL 바뀜",
  ai_review_exhausted: "1차 재시도 소진",
  second_review_split: "2차 갈림",
  second_review_split_qwen_reject: "2차 갈림(세 번째 표도 거부)",
  no_description: "소개 문구 없음",
};

/** 심사 큐가 갈래(?cause=)로 거를 수 있는 사유 — app/(operator)/admin/review/causes.ts 의 CAUSE_GUIDE 열쇠 */
const REVIEW_CAUSES = new Set(["second_review_split", "no_description", "ai_review_exhausted", "source_refresh_failed", "repo_deleted", "suspected_spam"]);
export const holdHref = (reason: string) => REVIEW_CAUSES.has(reason) ? `/admin/review?cause=${reason}#review-list` : null;

const PROGRESS_TEXT: Partial<Record<ProgressReason, string>> = {
  worker_missing: "워커가 응답하지 않습니다", no_progress: "대기가 있는데 처리가 없습니다", upstream_stalled: "같은 오류가 반복됩니다",
  consumer_missing: "처리하는 소비자가 끊겼습니다",
};

const n = (value: number) => value.toLocaleString("ko-KR");

/** 분 → "3시간", "2일" */
export function ageText(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 1) return "1분 미만";
  if (minutes < 60) return `${Math.floor(minutes)}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}시간`;
  return `${Math.floor(hours / 24)}일`;
}

/** 「순위가 비어 작업이 멈춤」의 칸 글자 — conveyor-llm.ts 도 같은 글자를 쓴다 */
export const NO_MODEL_TEXT = "모델 없음 — 멈춤";

/**
 * 칸의 판정에 모델 사정을 얹는다 — 읽기만 한다.
 * - 순위가 비어(또는 모두 못 써) 작업이 멈추면 칸을 막힘으로 올린다(여러 작업 중 일부면 쌓임). 이미 막힘이어도 까닭은 모델 쪽이 근본이라 바꾼다.
 */
export function applyStationLlm(station: Station, llm: StationLlm | null): Station {
  const next: Station = { ...station, llm };
  if (!llm || llm.kind !== "llm") return next;
  if (llm.stopped.length) {
    const all = llm.stopped.length >= llm.liveCount;
    const tone: BeltTone = all ? "jam" : "slow";
    if (RANK[tone] >= RANK[station.tone]) {
      const stuck = llm.tasks.some((task) => task.state === "stuck" && llm.stopped.includes(task.label));
      const stoppedTasks = llm.tasks.filter(task => llm.stopped.includes(task.label));
      const poolOnly = stoppedTasks.every(task => !!task.pool);
      const guidance = stoppedTasks.some(task => !!task.pool) ? "실행 방식·구성원 설정과 실행 오류를 확인하세요" : "순위를 채우세요";
      return { ...next, tone, status: all ? (poolOnly ? "쓸 수 있는 분산 모델 없음 — 멈춤" : stuck && !llm.tasks.some((task) => task.state === "none") ? "쓸 수 있는 순위 없음 — 멈춤" : NO_MODEL_TEXT) : "모델 없음 — 일부 멈춤",
        reason: `${llm.stopped.join(" · ")}: ${stoppedTasks[0]?.note ?? "모델 설정을 확인하세요"} 「작업 ↔ AI 모델」에서 ${guidance}` };
    }
    return next;
  }
  return next;
}

export const worstTone = (...tones: BeltTone[]) => tones.reduce((worst, tone) => RANK[tone] > RANK[worst] ? tone : worst, "idle" as BeltTone);

const sum = (points: HourPoint[] | undefined, pick: (point: HourPoint) => number) =>
  points ? points.reduce((total, point) => total + pick(point), 0) : null;
const series = (hourly: HourlySeries | null, pick: (point: HourPoint) => number) =>
  hourly?.points.length ? hourly.points.map(pick) : null;

const ROLE_OF: Record<string, string> = { fetch: "crawler", judge: "reviewer", first: "reviewer", second: "reviewer", publish: "publisher" };

/** 처리량 단계 하나의 판정 — 운영센터 레일(railTone·worker)과 같은 순서: 워커 경보 → 멈춤 → 쌓임 → 흐름 */
export function stageTone(stage: ThroughputStage | undefined, inputs: Pick<ConveyorInputs, "progress">): { tone: BeltTone; status: string; reason: string | null } {
  if (!stage) return { tone: "unknown", status: TONE_LABELS.unknown, reason: "처리량을 읽지 못했습니다" };
  const live = inputs.progress?.liveness.find((row) => row.role === ROLE_OF[stage.key]);
  if (live?.reason === "worker_missing") return { tone: "jam", status: "워커 끊김", reason: "이 칸을 처리하는 워커의 생존 신호가 45초 넘게 없습니다" };
  if (live?.reason === "restart_loop") return { tone: "jam", status: "반복 재시작", reason: "워커가 5분 안에 3번 넘게 다시 시작했습니다" };
  const signal = inputs.progress?.stages.find((row) => row.stage === stage.key);
  if (signal?.alarm) return { tone: "jam", status: TONE_LABELS.jam, reason: PROGRESS_TEXT[signal.reason] ?? "진행 판정 경보" };
  switch (stage.status) {
    case "paused": return { tone: "stop", status: "일시 중지", reason: "설정에서 꺼져 있습니다" };
    case "stalled": return { tone: "jam", status: TONE_LABELS.jam,
      reason: `${n(stage.waiting)}${stage.unit}이 최장 ${ageText(stage.oldestMinutes)} 기다리는데 5분 동안 처리 0` };
    case "backlog": return { tone: "slow", status: TONE_LABELS.slow, reason: "지금 속도로 30분 안에 다 못 비울 만큼 쌓였습니다" };
    case "processing": return { tone: "flow", status: TONE_LABELS.flow, reason: null };
    default: return { tone: "idle", status: TONE_LABELS.idle, reason: null };
  }
}

function holdChips(inputs: ConveyorInputs, station: StationKey): HoldChip[] {
  return (inputs.holds ?? []).filter((row) => HOLD_STATION[row.reason] === station && row.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((row) => ({ reason: row.reason, label: HOLD_LABELS[row.reason] ?? row.reason, count: row.count, recent24h: row.recent24h, href: holdHref(row.reason) }));
}

function queueStation(inputs: ConveyorInputs, key: "fetch" | "judge" | "first" | "second" | "publish", base: {
  phase: PhaseKey; label: string; what: string; links: Link[];
  hour?: (point: HourPoint) => number; done24h?: number | null; facts?: Fact[];
}): Station {
  const stage = inputs.throughput?.stages.find((row) => row.key === key);
  const verdict = stageTone(stage, inputs);
  const facts: Fact[] = [...(base.facts ?? [])];
  if (stage?.errors5m) facts.push({ label: "5분 오류", value: `${n(stage.errors5m)}건`, tone: "warn" });
  if (stage?.deferred) facts.push({ label: "재시도 예약", value: `${n(stage.deferred)}건` });
  if (stage?.manualAttention) facts.push({ label: "사람 확인으로 넘김", value: `${n(stage.manualAttention)}건`, tone: "warn" });
  return {
    key, phase: base.phase, label: base.label, what: base.what,
    waiting: stage?.waiting ?? null, oldestMinutes: stage?.oldestMinutes ?? null,
    done5m: stage?.completed5m ?? null,
    doneHour: base.hour && inputs.hourly?.lastHour ? base.hour({ hour: "", ...inputs.hourly.lastHour }) : null,
    done24h: base.done24h ?? (base.hour ? sum(inputs.hourly?.points, base.hour) : null),
    unit: stage?.unit ?? "건",
    spark: base.hour ? series(inputs.hourly, base.hour) : null,
    ...verdict, holds: holdChips(inputs, key), facts, links: base.links, llm: null,
  };
}

function discoverStation(inputs: ConveyorInputs): Station {
  const doneHour = inputs.hourly?.lastHour?.discovered ?? null;
  const done24h = inputs.flow?.stages.find((row) => row.key === "discover")?.entered ?? sum(inputs.hourly?.points, (point) => point.discovered);
  const failing = inputs.sources.filter((source) => source.failing && !source.paused);
  const allPaused = inputs.sources.length > 0 && inputs.sources.every((source) => source.paused);
  let tone: BeltTone; let status: string; let reason: string | null = null;
  if (!inputs.enabled || allPaused) { tone = "stop"; status = "일시 중지"; reason = !inputs.enabled ? "크롤 설정에서 수집이 꺼져 있습니다" : "모든 탐색 잡이 멈춰 있습니다"; }
  else if (done24h === null) { tone = "unknown"; status = TONE_LABELS.unknown; reason = "발견 수를 읽지 못했습니다"; }
  else if (done24h === 0) { tone = "jam"; status = TONE_LABELS.jam; reason = "24시간 동안 새로 찾은 저장소가 없습니다"; }
  else if (failing.length) { tone = "slow"; status = "오류 있음"; reason = `${failing.map((source) => source.label).join(" · ")} 마지막 실행이 실패했습니다`; }
  else if (doneHour === 0) { tone = "idle"; status = "이번 시간 0"; reason = null; }
  else { tone = "flow"; status = TONE_LABELS.flow; }
  const frontier = inputs.flow?.stages.find((row) => row.key === "discover")?.waiting;
  return {
    key: "discover", phase: "explore", label: "탐색", what: "GitHub 검색·Show HN에서 새 저장소를 찾아 수집 줄에 올립니다",
    waiting: null, oldestMinutes: null, done5m: null, doneHour, done24h, unit: "건",
    spark: series(inputs.hourly, (point) => point.discovered), tone, status, reason, holds: [],
    facts: [
      ...inputs.sources.map((source): Fact => ({ label: source.label,
        value: source.paused ? "멈춤" : source.lastSuccessAt ? `마지막 성공 ${ageText((Date.parse(inputs.now) - Date.parse(source.lastSuccessAt)) / 60_000)} 전` : "성공 기록 없음",
        tone: source.failing && !source.paused ? "warn" : undefined })),
      ...(frontier != null ? [{ label: "지금까지 찾은 저장소", value: `${n(frontier)}건` }] : []),
    ],
    links: [{ href: "/admin#signals", label: "검색 신호·수집 규칙" }], llm: null,
  };
}

function secondStation(inputs: ConveyorInputs): Station {
  const station = queueStation(inputs, "second", {
    phase: "review", label: "AI 2차", what: "1차가 승인한 후보를 별도 2차 호출로 다시 보고 표를 냅니다",
    hour: (point) => point.secondReviews,
    links: [{ href: "/admin/models/tasks", label: "2차 모델 정하기" }, { href: "/admin/review?stage=second#review-list", label: "2차 대기 보류 보기" }],
  });
  const splits = station.holds.filter((hold) => hold.reason.startsWith("second_review_split"));
  const recent = splits.reduce((total, hold) => total + (hold.recent24h ?? 0), 0);
  const total = splits.reduce((all, hold) => all + hold.count, 0);
  if (recent > 0 && RANK[station.tone] < RANK.slow) {
    // 2차 대기 줄에는 남지 않는 정체 — 표가 0 이면 막힘, 표가 나오는데도 갈림이 늘면 쌓임
    const noVotes = (station.done24h ?? 0) === 0;
    return { ...station, tone: noVotes ? "jam" : "slow", status: noVotes ? "표 0 · 보류로 빠짐" : "갈림 보류 늘어남",
      reason: noVotes
        ? `24시간 동안 2차 표가 하나도 없고, 1차 승인 후보가 "2차 갈림"으로 보류에 빠지고 있습니다(24시간 +${n(recent)} · 누적 ${n(total)}). 2차 실행 설정과 실제 호출·결과 저장을 확인하세요`
        : `2차 갈림 보류가 24시간 동안 ${n(recent)}건 늘었습니다(누적 ${n(total)})` };
  }
  return station;
}

function profileStation(inputs: ConveyorInputs): Station {
  const classification = inputs.classification;
  const intro = (inputs.holds ?? []).find((row) => row.reason === "no_description");
  const waiting = classification || intro ? (classification?.held ?? 0) + (intro?.count ?? 0) : null;
  const publish = inputs.throughput?.stages.find((row) => row.key === "publish");
  let tone: BeltTone; let status: string; let reason: string | null = null;
  if (waiting === null) { tone = "unknown"; status = TONE_LABELS.unknown; reason = "분류·소개 대기를 읽지 못했습니다"; }
  else if (waiting === 0) { tone = "idle"; status = TONE_LABELS.idle; }
  else if ((publish?.completed5m ?? 0) === 0 && (classification?.held ?? 0) > 0) {
    tone = "slow"; status = TONE_LABELS.slow; reason = `분류가 정해지지 않은 승인 후보 ${n(classification!.held)}건이 발행을 기다립니다`;
  } else { tone = "flow"; status = TONE_LABELS.flow; }
  // 시간별 선은 "한 줄 소개를 지은 저장소"(crawl_taglines) — 분류는 발행 순간에 같이 정해져 따로 남는 시각이 없다
  const tagline = (point: HourPoint) => point.taglines ?? 0;
  return {
    key: "profile", phase: "profile", label: "프로필 준비", what: "승인된 후보에 카테고리를 정하고 한 줄 소개를 지어 제품 프로필을 갖춥니다",
    waiting, oldestMinutes: null, done5m: null, doneHour: inputs.hourly?.lastHour ? tagline({ hour: "", ...inputs.hourly.lastHour }) : null,
    done24h: sum(inputs.hourly?.points, tagline), unit: "건", spark: series(inputs.hourly, tagline),
    rateLabel: "소개 지음",
    tone, status, reason, holds: [],
    facts: [
      { label: "선이 세는 것", value: "한 줄 소개를 지은 저장소(시간별) · 분류는 발행 때 함께 정해져 발행 선에 들어갑니다" },
      ...(classification ? [{ label: "분류 대기", value: `${n(classification.held)}건${classification.nextRetryAt
        ? ` · 다음 재분류 ${ageText(Math.max(0, (Date.parse(classification.nextRetryAt) - Date.parse(inputs.now)) / 60_000))} 뒤` : ""}` }] : []),
      ...(intro ? [{ label: "소개 문구 짓기 대기", value: `${n(intro.count)}건` }] : []),
    ],
    links: [{ href: "/admin/categories", label: "카테고리 기준" }, { href: holdHref("no_description")!, label: "소개 없음 보류" }], llm: null,
  };
}

function keywordStation(inputs: ConveyorInputs): Station {
  const health = inputs.search;
  const hour = (point: HourPoint) => point.keywords;
  const waiting = health ? health.pendingGeneration + health.pendingVerification : null;
  let tone: BeltTone; let status: string; let reason: string | null = null;
  if (!health) { tone = "unknown"; status = TONE_LABELS.unknown; reason = "검색 점검 기록(45분 안)이 없습니다"; }
  else if (health.generationIdleMinutes >= 30 && health.pendingGeneration > 0) {
    tone = "jam"; status = TONE_LABELS.jam; reason = `키워드 짓기 대기 ${n(health.pendingGeneration)}건이 있는데 ${ageText(health.generationIdleMinutes)} 동안 진행이 없습니다`;
  } else if (health.exhausted > 0 || health.oldMissing > 0) {
    tone = "slow"; status = "확인 필요";
    reason = [health.oldMissing > 0 && `공개 30분이 지나도 키워드가 없는 제품 ${n(health.oldMissing)}건`,
      health.exhausted > 0 && `재시도 한도에 닿은 제품 ${n(health.exhausted)}건`].filter(Boolean).join(" · ");
  } else if (waiting! > 0) { tone = "flow"; status = TONE_LABELS.flow; }
  else { tone = "idle"; status = TONE_LABELS.idle; }
  return {
    key: "keywords", phase: "keywords", label: "키워드 등록", what: "공개된 제품의 검색 키워드를 짓고, 검수하고, 검색에 싣습니다",
    waiting, oldestMinutes: health && health.pendingVerification > 0 ? health.oldestVerificationMinutes : null,
    done5m: null, doneHour: inputs.hourly?.lastHour?.keywords ?? null, done24h: sum(inputs.hourly?.points, hour), unit: "건",
    spark: series(inputs.hourly, hour), tone, status, reason, holds: [],
    facts: health ? [
      { label: "짓기 대기", value: `${n(health.pendingGeneration)}건` },
      { label: "검수 대기", value: `${n(health.pendingVerification)}건${health.pendingVerification ? ` · 최장 ${ageText(health.oldestVerificationMinutes)}` : ""}` },
      { label: "최근 지음 · 검수", value: `${n(health.generatedRecent)} · ${n(health.verifiedRecent)}` },
      ...(health.exhausted ? [{ label: "재시도 한도", value: `${n(health.exhausted)}건`, tone: "warn" as const }] : []),
      ...(health.oldMissing ? [{ label: "30분 넘게 없음", value: `${n(health.oldMissing)}건`, tone: "warn" as const }] : []),
    ] : [],
    links: [{ href: "/admin/status?tab=diagnostics", label: "검색 데이터 점검" }], llm: null,
  };
}

function humanBox(inputs: ConveyorInputs): HumanBox | null {
  const human = inputs.human;
  if (!human) return null;
  const decided = human.decided24h ? human.decided24h.approve + human.decided24h.reject : null;
  const direct = human.stages.human;
  let tone: BeltTone = human.person > 0 ? "flow" : "idle"; let status = human.person > 0 ? "처리 중" : "일감 없음"; let reason: string | null = null;
  if (humanBacklogged(direct)) { tone = "slow"; status = TONE_LABELS.slow; reason = `직접 판단 ${n(direct)}건 — 500건을 넘었습니다`; }
  else if (human.person > 0 && decided === 0) { tone = "slow"; status = "처리 없음"; reason = "24시간 동안 사람이 내린 결정이 없습니다"; }
  return {
    waiting: human.person, direct, agreed: human.stages.agreed, awaitingSecond: human.stages.second, awaitingAi: human.stages.ai,
    decided24h: decided, oldestDays: human.wait?.oldestDays ?? null, in24h: human.wait?.in24h ?? null, tone, status, reason, llm: null,
  };
}

function headlineFor(stations: Station[], human: HumanBox | null, bottleneck: Conveyor["bottleneck"], publishedHour: number | null): Conveyor["headline"] {
  const target = bottleneck === "human" ? null : stations.find((station) => station.key === bottleneck);
  const flowText = publishedHour === null ? "" : `최근 1시간 발행 ${n(publishedHour)}건`;
  if (bottleneck === "human" && human) {
    return { tone: human.tone, title: `지금 가장 막힌 곳: 사람 심사 — ${human.status}`, detail: [human.reason, flowText].filter(Boolean).join(" · ") };
  }
  if (target) {
    return { tone: target.tone, title: `지금 가장 막힌 곳: ${target.label} — ${target.status}`, detail: [target.reason, flowText].filter(Boolean).join(" · ") };
  }
  const unknown = stations.filter((station) => station.tone === "unknown");
  if (unknown.length) return { tone: "unknown", title: `막힌 곳 없음 · ${unknown.map((station) => station.label).join(" · ")} 미확인`, detail: flowText };
  return { tone: "flow", title: "모든 칸이 흐르고 있습니다", detail: flowText };
}

export function buildConveyor(inputs: ConveyorInputs): Conveyor {
  const stations: Station[] = [
    discoverStation(inputs),
    queueStation(inputs, "fetch", { phase: "explore", label: "원본 수집", what: "찾은 저장소의 README·홈페이지를 내려받습니다",
      done24h: inputs.flow?.stages.find((row) => row.key === "fetch")?.left ?? null,
      links: [{ href: "/admin/status?tab=crawlers", label: "크롤러 활동" }] }),
    queueStation(inputs, "judge", { phase: "review", label: "규칙 심사", what: "포크·대형 오픈소스·URL 없음 같은 규칙으로 먼저 거릅니다",
      hour: (point) => point.judged, links: [{ href: "/admin#judge", label: "판정 규칙" }] }),
    queueStation(inputs, "first", { phase: "review", label: "AI 1차", what: "모델이 제품·개인 프로필인지 처음 판정합니다",
      hour: (point) => point.firstReviews,
      facts: inputs.hourly?.lastHour?.firstFailed ? [{ label: "1시간 실패 호출", value: `${n(inputs.hourly.lastHour.firstFailed)}건`, tone: "warn" }] : [],
      links: [{ href: "/admin/models/tasks", label: "1차 모델 정하기" }, { href: "/admin/status#first-review-status", label: "1차 상세" }] }),
    secondStation(inputs),
    profileStation(inputs),
    queueStation(inputs, "publish", { phase: "publish", label: "발행", what: "준비된 제품을 공개 목록에 올립니다",
      hour: (point) => point.published, links: [{ href: "/admin/products", label: "제품 목록" }] }),
    keywordStation(inputs),
  ];
  const models = inputs.models ?? null;
  for (let index = 0; index < stations.length; index++) stations[index] = applyStationLlm(stations[index], models?.[stations[index].key] ?? null);
  const human = humanBox(inputs);
  if (human) human.llm = models?.human ?? null;

  // 같은 급(막힘·쌓임·멈춤)이면 앞(위쪽) 칸이 먼저다 — 앞 칸이 막히면 뒤 칸은 일감이 끊겨 원인이 가려진다.
  // 2026-11-02 21:13Z 1차 순위가 지워져 1차가 0건이 됐을 때, 쌓인 수로 고르면 이틀째 막힌 2차(보류 3,700건)가 계속 머리에 있어 새 장애가 묻혔다.
  // 사람 심사는 벨트 밖이라 맨 뒤
  const candidates: { key: Conveyor["bottleneck"]; tone: BeltTone; order: number }[] = [
    ...stations.map((station, order) => ({ key: station.key, tone: station.tone, order })),
    ...(human ? [{ key: "human" as const, tone: human.tone, order: stations.length }] : []),
  ].filter((row) => row.tone === "jam" || row.tone === "slow" || row.tone === "stop");
  candidates.sort((a, b) => RANK[b.tone] - RANK[a.tone] || a.order - b.order);
  const bottleneck = candidates[0]?.key ?? null;

  const published = inputs.flow?.published ?? null;
  const publishedHour = inputs.hourly?.lastHour?.published ?? null;
  const held = inputs.holds ? inputs.holds.reduce((total, row) => total + row.count, 0) : null;

  const funnel: FunnelRow[] = [
    { key: "discover", label: "탐색", value: stations[0].done24h, unit: "건" },
    { key: "fetch", label: "원본 수집", value: stations[1].done24h, unit: "건" },
    { key: "judge", label: "규칙 심사", value: stations[2].done24h, unit: "건" },
    { key: "first", label: "AI 1차", value: stations[3].done24h, unit: "건", note: "끝난 모델 심사" },
    { key: "second", label: "AI 2차", value: stations[4].done24h, unit: "표", note: "후보가 아니라 표 수" },
    { key: "human", label: "사람 결정", value: human?.decided24h ?? null, unit: "건" },
    { key: "publish", label: "발행", value: stations[6].done24h, unit: "건" },
    { key: "keywords", label: "키워드 등록", value: stations[7].done24h, unit: "건" },
  ];

  const holdsByReason = (inputs.holds ?? []).filter((row) => row.count > 0).sort((a, b) => b.count - a.count)
    .map((row) => ({ reason: row.reason, label: HOLD_LABELS[row.reason] ?? row.reason, count: row.count, recent24h: row.recent24h,
      href: holdHref(row.reason), station: HOLD_STATION[row.reason] ?? ("human" as const) }));

  return {
    measuredAt: inputs.now, hours: inputs.hourly?.points.length ? inputs.hourly.points.map((point) => point.hour) : null, stations, human, held, rejected: inputs.rejected, published, publishedHour,
    bottleneck, headline: headlineFor(stations, human, bottleneck, publishedHour), funnel, holdsByReason, sinkLlm: models?.sink ?? null,
    supportLlm: models?.support ?? null,
  };
}
