import { humanFlowLabel, humanWaitLabel, type HumanQueueOverview } from "@/lib/crawl/human-queue";
import { REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { sameReviewModel } from "@/lib/crawl/review-model-identity";
import { SHOW_HN_SIGNAL, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { formatAgo, formatDetailTime } from "@/lib/format/time";
import { isPausedJob } from "@/lib/jobs/status";
import type { AttentionCounts, HourlySeries, ModelHealth } from "@/lib/operations/dashboard";
import type { DeferralsRead, EvidenceVerdicts, SlotWindows, SourceSplit } from "@/lib/operations/flow-reads";
import type { PipelineFlow } from "@/lib/operations/pipeline";
import type { PipelineControlStatus } from "@/lib/operations/pipeline-control-status";
import { replicaHoldText, type ReplicaRead } from "@/lib/operations/replica-hold";
import type { SearchHealth } from "@/lib/operations/search-health-model";
import { PIPELINE_STAGES, resolveModelSlots, type ModelSlot } from "@/lib/operations/stage-registry";
import type { ThroughputSnapshot } from "@/lib/operations/throughput-model";
import type { StageProgress } from "@/lib/operations/worker-progress";
import type { WorkerProgressReport } from "@/lib/operations/worker-progress-query";
import type { XStatusView } from "@/lib/operations/x-status";
import type { ActionItem, SplitItem } from "./dashboard/AttentionList";
import { modelName, modelTone, slotTitle } from "./dashboard/ModelCards";
import { age, PROGRESS, railTone, worker } from "./dashboard/StageRail";

/**
 * 운영센터 개편 v8 의 새 요소가 쓰는 판단 — 모두 순수 함수다(DB 를 읽지 않는다).
 *
 * 판정 규칙을 새로 만들지 않는다. 단계 색은 레일(StageRail)의 railTone·worker, 보강 단계는 지금 조치(buildActions)의
 * 급(critical·hold·clear)과 잡 상태를 그대로 옮긴다. 판정 알약은 조치와 같은 동기 입력만 받는다 — 첫 그림을 기다리게 하지 않는다.
 * 쉬운 말은 새 요소에만 쓰고 코드 이름을 괄호로 함께 적는다(쉬운 말(코드)).
 */
export type FlowTone = "ok" | "warn" | "bad" | "idle";
export type StageDot = { key: string; short: string; label: string; tone: FlowTone; text: string };
export type FlowVerdict = { tone: FlowTone; text: string; short: string; title: string; dots: StageDot[] };

const n = (value: number) => value.toLocaleString("ko-KR");
/** 새 숫자의 DB 기준 시각 "08:44:02" (KST) */
export const dbClock = (at: string) => formatDetailTime(at).split(" ")[1] ?? "—";
const RANK: Record<FlowTone, number> = { idle: 0, ok: 1, warn: 2, bad: 3 };
export const worstTone = (...tones: FlowTone[]): FlowTone => tones.reduce((worst, tone) => RANK[tone] > RANK[worst] ? tone : worst, "idle");
const actionTone = (tone: ActionItem["tone"]): FlowTone => tone === "critical" ? "bad" : tone === "hold" ? "warn" : "ok";

const REVIEW_SHORT: Record<string, string> = { fetch: "수집", judge: "규칙", first: "1차", second: "2차", human: "사람", publish: "발행" };
export const REVIEW_STAGES = PIPELINE_STAGES.filter((row) => row.group === "review");
export const ENRICHMENT_STAGES = PIPELINE_STAGES.filter((row) => row.group === "enrichment");

/** 사람 심사 — 레일의 사람 칸과 같은 수. 500건이 넘거나 24시간 동안 사람이 처리한 것이 없으면 쌓임(병목 판정과 같은 뜻) */
function humanDot(human: HumanQueueOverview): StageDot {
  const count = human.stages.human;
  const decided = human.decided24h ? human.decided24h.approve + human.decided24h.reject : null;
  const tone: FlowTone = count > 500 || (count > 0 && decided === 0) ? "warn" : count > 0 ? "ok" : "idle";
  return { key: "human", short: REVIEW_SHORT.human, label: "사람 심사", tone, text: tone === "warn" ? "쌓임" : tone === "ok" ? "흐름" : "일감 없음" };
}

/** 심사 흐름 6단계의 지금 상태 — 레일과 같은 입력(throughput · worker progress · 사람 몫), 같은 색 규칙 */
export function reviewDots({ throughput, workerProgress, human }: {
  throughput: ThroughputSnapshot | null; workerProgress: WorkerProgressReport | null; human: HumanQueueOverview;
}): StageDot[] {
  return REVIEW_STAGES.map((def): StageDot => {
    if (def.key === "human") return humanDot(human);
    const base = { key: def.key, short: REVIEW_SHORT[def.key], label: def.label };
    const stage = throughput?.stages.find((row) => row.key === def.throughputKey);
    if (!stage) return { ...base, tone: "warn", text: "미확인" };
    const state = worker(stage, workerProgress?.stages.find((row) => row.stage === stage.key), workerProgress?.liveness);
    const tone = railTone(stage.status, stage.manualAttention ?? 0, state.alarm);
    if (tone === "bad") return { ...base, tone, text: state.text };
    if (tone === "warn") return { ...base, tone, text: stage.status === "backlog" ? "쌓임" : `직접 확인 ${n(stage.manualAttention ?? 0)}건` };
    if (stage.status === "paused") return { ...base, tone: "idle", text: "일시 중지" };
    return stage.status === "idle" ? { ...base, tone: "idle", text: "일감 없음" } : { ...base, tone: "ok", text: "흐름" };
  });
}

/**
 * 탭 줄 끝의 판정 알약 — "지금 괜찮은가". 조치 입력(throughput · worker progress · 사람 몫 · 조치 분할)만으로 센다. 새 쿼리가 없다.
 * 급한 일 = 지금 조치의 critical, 새 일 = 기준 시각 뒤에 새로 생긴 것, 조치 = 그 밖에 지금 조치에 선 것(장애·설정).
 */
export function flowVerdict({ split, throughput, workerProgress, human }: {
  split: { urgent: SplitItem[] }; throughput: ThroughputSnapshot | null; workerProgress: WorkerProgressReport | null; human: HumanQueueOverview;
}): FlowVerdict {
  const critical = split.urgent.filter((item) => item.tone === "critical").length;
  const fresh = split.urgent.filter((item) => item.tone !== "critical" && item.fresh).length;
  const other = split.urgent.length - critical - fresh;
  const parts = [critical && `급한 일 ${n(critical)}`, fresh && `새 일 ${n(fresh)}`, other && `조치 ${n(other)}`].filter(Boolean) as string[];
  const dots = reviewDots({ throughput, workerProgress, human });
  const bad = dots.filter((dot) => dot.tone === "bad");
  // 쌓임·미확인을 "직접 확인"(자동 처리가 끝나 사람 몫만 남은 것)보다 먼저 말한다 — 흐름이 막힌 곳이 먼저다
  const warn = dots.filter((dot) => dot.tone === "warn").sort((a, b) => Number(b.text === "쌓임" || b.text === "미확인") - Number(a.text === "쌓임" || a.text === "미확인"));
  const worst = [...bad, ...warn];
  const flow = !throughput ? "미확인" : worst.length ? `${worst[0].label} ${worst[0].text}${worst.length > 1 ? ` 외 ${worst.length - 1}` : ""}` : "막힌 곳 없음";
  const tone: FlowTone = critical || bad.length ? "bad" : fresh || other || warn.length ? "warn" : "ok";
  return {
    tone, dots, short: parts[0] ?? "조치 없음",
    text: `지금 · ${parts.length ? parts.join(" · ") : "조치 없음"} · 흐름: ${flow}`,
    title: `조치 입력(동기)만으로 계산 — 급한 일(critical) ${critical} · 새로 생긴 일(fresh) ${fresh} · 그 밖 조치 ${other} · `
      + `단계 판정(throughput·worker progress·사람 몫): ${dots.map((dot) => `${dot.label} ${dot.text}`).join(" · ")}`,
  };
}

/**
 * 지금 조치의 키 → 그 일을 하는 보강 단계. 보강 칸의 색은 이 조치의 급을 그대로 쓴다(판정 규칙 변경 0).
 * 잡의 처리(밀림·멈춤·실패)를 말하는 조치만 잇는다. 사람이 정할 쌓인 일(감사 거절 audit · 소개 확인 intro · 저장소 사라짐 repo-gone ·
 * 스팸 자동 차단 spam-auto-ban)은 보강 흐름이 막힌 것이 아니라 전체 현황의 "쌓인 일"에 있다.
 */
const ENRICHMENT_ACTIONS: Readonly<Record<string, string>> = {
  "evidence-backlog": "evidence",
  "search-hash": "keywords", "search-copies": "keywords", "search-missing": "keywords", "search-exhausted": "keywords",
  "search-repeated": "keywords", "search-generation-stalled": "keywords", "search-verification-wait": "keyword-verify",
  "model-servers": "embedding", "audit-stalled": "audit", "repo-coverage": "stars", "health-overdue": "uptime",
};
const EVIDENCE_STAGE_KEYS = new Set(["evidence", "agent-evidence", "ai-level"]);

/** 워커 진행 판정의 색 — 경보는 빨강, 재시도·오류·시각 미확인은 주황, 일감 없음·멈춤은 회색 */
export function progressTone(row: Pick<StageProgress, "reason" | "alarm">): FlowTone {
  if (row.alarm) return "bad";
  if (row.reason === "paused" || row.reason === "no_work") return "idle";
  return row.reason === "progressing" || row.reason === "running" || row.reason === "warming_up" ? "ok" : "warn";
}

export type EnrichmentNode = { key: string; label: string; code: string; headline: boolean; tone: FlowTone; state: string; value: string | null; note: string };
type EnrichmentJob = { name: string; lastError?: string | null; notBefore: Date | null; lastRunAt?: Date | null };

/**
 * 발행 후 보강 단계(12칸 + 그 밖) — 근거 3단계는 배포 관문과 같은 판정(복제본에서 읽은 새 숫자), 나머지는 지금 조치의 급·잡 상태와
 * 이미 읽은 수(검색 점검·운영 집계)다. 근거를 못 읽으면 그 세 칸만 보류다.
 */
export function enrichmentNodes({ actions, jobs, evidence, health, attention, now }: {
  actions: ActionItem[]; jobs: EnrichmentJob[]; evidence: ReplicaRead<EvidenceVerdicts>;
  health: SearchHealth | null; attention: AttentionCounts | null; now: string;
}): EnrichmentNode[] {
  const nowMs = Date.parse(now);
  return ENRICHMENT_STAGES.map((def): EnrichmentNode => {
    const node = { key: def.key, label: def.label, code: def.code, headline: def.headline === true };
    if (EVIDENCE_STAGE_KEYS.has(def.key)) {
      if (!evidence.ok) return { ...node, tone: "idle", state: "보류", value: null, note: replicaHoldText(evidence.reason) };
      const row = evidence.value.stages.find((stage) => stage.stage === def.progressKey);
      if (!row) return { ...node, tone: "idle", state: "미관측", value: null, note: "판정 없음" };
      const waiting = row.waiting ?? 0;
      return { ...node, tone: worstTone(progressTone(row), ...actions.filter((item) => ENRICHMENT_ACTIONS[item.key] === def.key).map((item) => actionTone(item.tone))),
        state: PROGRESS[row.reason], value: n(waiting),
        note: waiting > 0 ? `대기 · 최장 ${age(row.oldestMinutes ?? null, waiting)}` : `대기 · 5분 ${n(row.completed5m ?? 0)}` };
    }
    const own = jobs.filter((job) => def.jobs.includes(job.name));
    const mapped = actions.filter((item) => ENRICHMENT_ACTIONS[item.key] === def.key).map((item) => actionTone(item.tone));
    const failed = own.some((job) => job.lastError);
    const paused = own.length > 0 && own.every((job) => isPausedJob(job, nowMs));
    const tone = failed ? "bad" : mapped.length ? worstTone(...mapped) : paused ? "idle" : "ok";
    const state = failed ? "오류 확인" : tone === "bad" ? "급함" : tone === "warn" ? "주의" : paused ? "멈춤(사람이 중단)" : "흐름";
    const lastRun = own.map((job) => job.lastRunAt).filter((at): at is Date => !!at).sort((a, b) => b.getTime() - a.getTime())[0];
    const fallback = { value: null, note: lastRun ? `마지막 실행 ${formatAgo(lastRun, now)}` : "실행 기록 없음" };
    const repo = attention?.repoHealth;
    const facts: Record<string, { value: string | null; note: string }> = {
      keywords: health ? { value: n(health.pendingGeneration), note: "대기" } : { value: null, note: "검색 점검 결과 없음" },
      "keyword-verify": health ? { value: n(health.pendingVerification), note: "검수 대기" } : { value: null, note: "검색 점검 결과 없음" },
      audit: attention?.auditCampaign ? { value: n(attention.auditCampaign.unanswered), note: "남음" } : fallback,
      stars: repo && repo.tracked > 0 ? { value: `${Math.floor((repo.checked24h / repo.tracked) * 100)}%`, note: "24시간 확인 범위" } : fallback,
      uptime: attention ? { value: n(attention.healthOverdue), note: "6시간 넘게 밀림" } : fallback,
      "intro-check": attention ? { value: n(attention.introNeedsEditor), note: "사람 확인 필요" } : fallback,
      "repo-review": attention ? { value: n(attention.repoGone.installable + attention.repoGone.website), note: "저장소 사라짐" } : fallback,
      "spam-rescan": attention ? { value: n(attention.spamAutoBans.day), note: "24h 자동 차단" } : fallback,
    };
    return { ...node, tone, state, ...(facts[def.key] ?? fallback) };
  });
}

export type CellSummary = { tone: FlowTone; value: string; note: string };

/** 발행 후 보강 칸 — 주의(주황·빨강) 단계 수와 이름 둘, 근거 판정의 DB 기준 시각 */
export function enrichmentSummary(nodes: EnrichmentNode[], evidence: ReplicaRead<EvidenceVerdicts>): CellSummary {
  const flagged = nodes.filter((node) => node.tone === "warn" || node.tone === "bad");
  const names = flagged.slice(0, 2).map((node) => node.label).join(" · ") + (flagged.length > 2 ? ` 외 ${flagged.length - 2}` : "");
  return {
    tone: worstTone(...nodes.map((node) => node.tone)),
    value: flagged.length ? `주의 ${flagged.length} · ${names}` : "모두 흐름",
    note: evidence.ok ? `근거 판정 기준 ${dbClock(evidence.value.at)} (DB)` : `근거 판정 보류 — ${replicaHoldText(evidence.reason)}`,
  };
}

/** X 수집기 보고(PR9) — 이미 읽은 관측 줄에서 꺼낸 것(readXStatus). 새 쿼리가 없다 */
export function xSummary(view: XStatusView): CellSummary {
  const report = view.report;
  const mode = report?.mode === "live" ? "실제 수집(live)" : report?.mode === "dry-run" ? "시험 실행(dry-run)" : "꺼짐(disabled)";
  const received = view.receivedAt ? `받은 시각 ${dbClock(view.receivedAt)} (DB)` : "받은 보고 없음";
  switch (view.state) {
    case "unconfigured": return { tone: "idle", value: "X 연결 전", note: "받는 주소 꺼짐(비밀 없음)" };
    case "missing": return { tone: "idle", value: "X 연결 전", note: "아직 받은 보고 없음" };
    case "disabled": return { tone: "idle", value: "X 꺼짐(disabled)", note: received };
    case "ok": return { tone: "ok", value: `X 후보 ${n(report!.candidates)}`, note: `${mode} · 읽기 ${n(report!.reads.used)}/${n(report!.reads.limit)} · ${received}` };
    case "stale": return { tone: "warn", value: "X 보고 끊김(stale)", note: `${mode} · ${received}` };
    case "error": return { tone: "warn", value: "X 오류(error)", note: `${report?.error ?? "오류"} · ${received}` };
    default: return { tone: "warn", value: "X 보고 확인 필요(invalid)", note: received };
  }
}

/** 들어오는 곳 칸 — 이번 시 GitHub 검색(설정의 검색 신호) · Show HN · 그 밖(관리자 재수집 등) */
export function sourceSummary(split: ReplicaRead<SourceSplit>, settings: Pick<CrawlSettings, "discover">):
  CellSummary & { at: string | null; counts: { github: number; showHn: number; other: number } | null } {
  if (!split.ok) return { tone: "idle", value: "보류", note: replicaHoldText(split.reason), at: null, counts: null };
  const queries = new Set(settings.discover.queries.map((query) => query.label));
  const counts = { github: 0, showHn: 0, other: 0 };
  for (const row of split.value.signals) counts[row.signal === SHOW_HN_SIGNAL ? "showHn" : queries.has(row.signal) ? "github" : "other"] += row.count;
  return { tone: counts.github + counts.showHn > 0 ? "ok" : "idle", counts, at: split.value.at,
    value: `GitHub ${n(counts.github)} · Show HN ${n(counts.showHn)}${counts.other ? ` · 기타 ${n(counts.other)}` : ""}`,
    note: `이번 시 · 기준 ${dbClock(split.value.at)} (DB)` };
}

const DEFAULT_MODES: Readonly<Record<string, string>> = { batch: "legacy", source: "disabled", model: "disabled", http: "disabled", uptime: "disabled" };
const MODE_WORDS: Readonly<Record<string, string>> = { legacy: "기존 방식", draining: "전환 중", versioned: "분리 배치", items: "항목 처리",
  open: "켜짐", disabled: "꺼짐", observing: "관측만", gated: "판정 관문" };
export const modeWord = (mode: string | null) => mode === null ? "확인 안 됨" : `${MODE_WORDS[mode] ?? mode}(${mode})`;

/**
 * 설정 전환 · 재해 복구 칸 — 장부 조각과 같은 제어 상태(같은 렌더의 cache() 결과)를 쉬운 말(코드)로. 새 쿼리가 없다.
 * 정산 안 된 호출 = 공통 모델 슬롯·공유 HTTP 의 미정산(dispatched + indeterminate).
 * 담당 권한 이상 = 기한이 지났는데 놓지 않은 소유(단계·사이트 근거) + 담당자가 없거나 기한이 지난 역할 담당(role lease).
 */
export function transitionSummary(status: PipelineControlStatus): CellSummary & { unsettled: number | null; leaseIssues: number | null } {
  const modes = [...status.controls.map((row) => ({ name: row.label, mode: row.mode, base: DEFAULT_MODES[row.key] })),
    ...status.stages.map((row) => ({ name: `단계 ${row.stage}`, mode: row.mode, base: "legacy" }))];
  const unknown = modes.filter((row) => row.mode === null);
  const changed = modes.filter((row) => row.mode !== null && row.mode !== row.base);
  const draining = modes.some((row) => row.mode === "draining");
  const metric = (key: string, label: string) => status.controls.find((row) => row.key === key)?.metrics.find((row) => row.label === label)?.value ?? null;
  const sum = (values: (number | null)[]) => values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + value!, 0);
  const unsettled = sum([metric("model", "미정산"), metric("http", "미정산")]);
  const leaseIssues = status.observedAt === null || !status.runtime.ownersRead ? null
    : sum([...status.stages.map((row) => row.unsettled), metric("source", "기한 지난 미정산"), status.owners.filter((row) => row.live === false).length]);
  const dr = status.runtime.dr.state === "active" ? "쓰기 가능(active)" : status.runtime.dr.state === "fenced" ? "쓰기 잠금(fenced)" : "쓰기 잠금 확인 안 됨";
  const modeText = unknown.length ? `확인 안 됨 ${unknown.length}` : draining ? "전환 중(draining)"
    : changed.length ? `기본과 다름 ${changed.length} · ${changed.slice(0, 2).map((row) => `${row.name} ${modeWord(row.mode)}`).join(" · ")}` : "모두 기본";
  const count = (value: number | null) => value === null ? "확인 안 됨" : n(value);
  return {
    tone: unknown.length || draining || status.runtime.dr.state !== "active" ? "warn" : "idle",
    value: `${modeText} · ${dr}`,
    note: `정산 안 된 호출(unsettled) ${count(unsettled)} · 담당 권한(lease) 이상 ${count(leaseIssues)}`,
    unsettled, leaseIssues,
  };
}

/**
 * 모델 카드 네 줄의 자리 → modelHealth 열쇠. 카드의 2차 투표는 1차와 다른 첫 투표자다(modelHealth 와 같다), 2차 예비는 첫 예비.
 */
export function cardSlotKeys(settings: Pick<CrawlSettings, "firstReview" | "secondReview">): Map<string, ModelHealth["key"]> {
  const first = settings.firstReview?.model ?? null;
  const voter = settings.secondReview.voters.findIndex((row) => !sameReviewModel(row.model, first));
  return new Map<string, ModelHealth["key"]>([["first", "first"], ["keywords", "keywords"], ["second-fallback-1", "fallback"],
    ...(voter >= 0 ? [[`second-voter-${voter + 1}`, "second"] as [string, ModelHealth["key"]]] : [])]);
}

/** 모델 카드 네 줄(1차 · 2차 투표 · 2차 예비 · 키워드 짓기)이 보이지 않는 자리 */
export function otherModelSlots(settings: Pick<CrawlSettings, "firstReview" | "secondReview">, env: Readonly<Record<string, string | undefined>> = process.env): ModelSlot[] {
  const card = cardSlotKeys(settings);
  return resolveModelSlots(settings, env).filter((slot) => !card.has(slot.key));
}

const percent = (part: number, whole: number) => whole > 0 ? `${Number(((part / whole) * 100).toFixed(1))}%` : "—";
const roundPercent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;
/** 결과 행에 실패가 남지 않는 자리 — 성공 수만 센다 */
const SUCCESS_ONLY = new Set(["embedding"]);

export type SlotChip = { tone: "ok" | "warn" | "bad" | undefined; text: string };
export type SlotRow = { key: string; stage: string; title: string; model: string | null; observed: string | null; source: ModelSlot["source"];
  approximated: boolean; chip: SlotChip; day: string; week: string; agree: string | null };

/** 최근 1시간 알약 — 모델 카드와 같은 색 규칙(modelTone). 글자는 "26% (9/35)" */
function exactChip(row: Pick<ModelHealth, "key" | "calls1h" | "failed1h" | "agreement1h">): SlotChip {
  const state = modelTone(row);
  if (row.calls1h === 0) return { tone: state.tone, text: state.text };
  const failed = `${roundPercent(row.failed1h, row.calls1h)} (${row.failed1h}/${row.calls1h})`;
  return { tone: state.tone, text: state.text.startsWith("일치") ? `${state.text} · ${failed}` : failed };
}

/**
 * 흐름 상세의 모델 자리 전체 표. 카드 네 자리의 최근 1시간은 지금 수(modelHealth, 렌더마다)를 그대로 쓰고, 나머지는 복제본 새 숫자다.
 * 24h·7일은 회색 참고. 근사 자리(결과 행)는 색 없이 "참고"다 — 머리 칩·조치에도 넣지 않는다(v8 검토 H).
 */
export function slotRows({ settings, slots, models, day, week }: {
  settings: Pick<CrawlSettings, "firstReview" | "secondReview">; slots: ModelSlot[]; models: ModelHealth[] | null;
  day: ReplicaRead<SlotWindows>; week: ReplicaRead<SlotWindows>;
}): SlotRow[] {
  const card = cardSlotKeys(settings);
  const find = (read: ReplicaRead<SlotWindows>, key: string) => read.ok ? read.value.rows.find((row) => row.slot === key) : undefined;
  const window = (read: ReplicaRead<SlotWindows>, key: string) => {
    if (!read.ok) return "보류";
    const row = find(read, key);
    if (!row || row.calls === 0) return "—";
    return SUCCESS_ONLY.has(key) ? `결과 ${n(row.calls)}` : percent(row.failed, row.calls);
  };
  return slots.map((slot): SlotRow => {
    const health = card.has(slot.key) ? models?.find((row) => row.key === card.get(slot.key)) : undefined;
    const recent = find(day, slot.key);
    const voting = slot.stage === "second";
    let chip: SlotChip;
    if (health) chip = exactChip(health);
    else if (!day.ok) chip = { tone: undefined, text: "보류" };
    else if (slot.approximated) chip = { tone: undefined, text: !recent || recent.calls1h === 0 ? "참고 · 결과 없음"
      : SUCCESS_ONLY.has(slot.key) ? `참고 · 결과 ${n(recent.calls1h)}건` : `참고 · 실패 ${roundPercent(recent.failed1h, recent.calls1h)}` };
    else chip = exactChip({ key: slot.key.startsWith("second-voter") ? "second" : slot.key === "first" ? "first" : "fallback",
      calls1h: recent?.calls1h ?? 0, failed1h: recent?.failed1h ?? 0, agreement1h: recent?.agree1h ?? null });
    const agreement = health ? health.agreement1h : recent?.agree1h ?? null;
    return { key: slot.key, stage: slot.stage, title: slotTitle(slot), model: slot.model, observed: recent?.observed ?? null, source: slot.source,
      approximated: slot.approximated, chip, day: window(day, slot.key), week: window(week, slot.key),
      agree: voting ? agreement === null ? "—" : `${Math.round(agreement * 100)}%` : null };
  });
}

const DEFER_WORDS: Readonly<Record<string, string>> = { model_capacity: "모델 자리", stage_blocked: "앞 단계 막힘", http_origin_permit: "접속 허가",
  source_buffer: "소스 버퍼", batch_blocked: "작업 배치 막힘", provider_circuit_open: "공급자 회로 열림" };
/** 미룬 이유 코드 → "쉬운 말(코드)" */
export function deferralLabel(code: string): string {
  const word = DEFER_WORDS[code] ?? (code.startsWith("host_") ? "host 예산" : code.startsWith("emergency_") ? "비상 예산" : "미룬 이유");
  return `${word}(${code})`;
}

/** 잡 묶음의 최근 1시간 미룬 이유 — "모델 자리(model_capacity) 3 · 앞 단계 막힘(stage_blocked) 1" */
export function deferralText(rows: DeferralsRead["jobs"], jobs: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) if (jobs.includes(row.job)) for (const [reason, value] of Object.entries(row.lastHourByReason)) counts.set(reason, (counts.get(reason) ?? 0) + value);
  return counts.size ? [...counts].sort((a, b) => b[1] - a[1]).map(([reason, value]) => `${deferralLabel(reason)} ${n(value)}`).join(" · ") : null;
}

/** 장부 숫자 칸 → 쉬운 말(코드). 장부 카드의 글자는 그대로 두고 흐름 상세 요약에만 쓴다 */
const METRIC_WORDS: Readonly<Record<string, string>> = {
  "writer 계약": "쓰기 규약 판(writer 계약)", "유효 소유": "처리 중(유효 소유)", "기한 지난 미정산": "기한 지난 미정산(expired)",
  "재시도 시각 도달": "재시도 시각 도달(due)", "재시도 예약": "재시도 예약(backoff)", "대기": "대기(waiting)", "최장 대기(분)": "최장 대기(분)",
  "예약": "예약(reserved)", "미정산": "정산 안 됨(unsettled)", dispatched: "보낸 호출(dispatched)", indeterminate: "결과 확인 안 됨(indeterminate)",
  "설정 상한": "설정 상한(limit)", "Oracle 점유": "Oracle 점유(oracle)", "원시 관측": "원시 관측(raw_only)", "판정 보류": "판정 보류(hold)",
  "적용 기록": "적용 기록(applied)", "설정 관측지": "설정 관측지(sources)",
};
const STAGE_WORDS: Readonly<Record<string, string>> = { fetch: "원본", ai1: "AI1", ai2: "AI2" };
const unknown = (value: number | null) => value === null ? "확인 안 됨" : n(value);

export type LedgerRow = { name: string; state: string; numbers: string };

/** 장부 쉬운 말 요약 — 전체 현황 장부 카드와 같은 값(같은 렌더의 cache() 결과) */
export function ledgerRows(status: PipelineControlStatus): LedgerRow[] {
  const controls = status.controls.map((row): LedgerRow => ({ name: row.label, state: modeWord(row.mode),
    numbers: [`담당 차례(epoch) ${unknown(row.epoch)}`, `설정 판(revision) ${unknown(row.revision)}`,
      ...row.metrics.map((metric) => `${METRIC_WORDS[metric.label] ?? metric.label} ${unknown(metric.value)}`)].join(" · ") }));
  const sum = (values: (number | null)[]) => values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + value!, 0);
  const dr = status.runtime.dr;
  const owners = status.owners;
  return [
    ...controls,
    { name: "단계별 소유권", state: status.stages.map((row) => `${STAGE_WORDS[row.stage] ?? row.stage} ${modeWord(row.mode)}`).join(" · "),
      numbers: `쓰기 규약 판(writer 계약) ${status.stages.map((row) => unknown(row.contract)).join("/")} · 처리 중(유효 소유) ${unknown(sum(status.stages.map((row) => row.live)))}`
        + ` · 기한 지난 미정산(expired) ${unknown(sum(status.stages.map((row) => row.unsettled)))}` },
    { name: "재해 복구 쓰기 잠금(DR writer fence)", state: dr.state === "active" ? "쓰기 가능(active)" : dr.state === "fenced" ? `쓰기 잠금(fenced)${dr.reason ? ` · ${dr.reason}` : ""}` : "확인 안 됨",
      numbers: `쓰기 담당 차례(writer epoch) ${unknown(dr.epoch)} · 진행 중 승격(promoted) ${unknown(dr.promoted)} · 봉인된 승격(sealed) ${dr.sealed === null ? "확인 안 됨" : n(dr.sealed.length)}` },
    { name: "서버별 담당 권한(lease)", state: status.runtime.ownersRead ? `역할 ${n(owners.length)}개` : "확인 안 됨",
      numbers: status.runtime.ownersRead ? `유효(live) ${n(owners.filter((row) => row.live === true).length)} · 기한 지남(expired) ${n(owners.filter((row) => row.live === false).length)}`
        + ` · 서버 미지정(host 미확인) ${n(owners.filter((row) => row.host === null).length)}` : "확인 안 됨" },
  ];
}

/** 흐름 상세의 노드 하나 — 큰 수·단위·한 줄 설명, 24시간 막대(맨 오른쪽이 이번 시), 모델 알약 */
export type FlowNodeModel = { name: string; title: string; chip: SlotChip };
export type FlowNode = { key: string; label: string; code: string; tone: FlowTone; state: string; big: string | null; unit: string; io: string;
  bars?: number[]; models?: FlowNodeModel[] };

const intervalWord = (job: string) => {
  const ms = JOB_CATALOG.find((row) => row.name === job)?.intervalMs ?? null;
  return ms === null ? "요청할 때" : ms % 3_600_000 === 0 ? `${ms / 3_600_000}시간마다` : `${Math.round(ms / 60_000)}분마다`;
};
const jobTone = (jobs: EnrichmentJob[], names: readonly string[], now: number): { tone: FlowTone; state: string } | null => {
  const own = jobs.filter((job) => names.includes(job.name));
  if (own.some((job) => job.lastError)) return { tone: "bad", state: "오류 확인" };
  if (own.length && own.every((job) => isPausedJob(job, now))) return { tone: "idle", state: "멈춤(사람이 중단)" };
  return null;
};

/** 들어오는 곳 — GitHub 검색 · Show HN(이번 시, 복제본) · X(PR9 보고) */
export function sourceNodes({ settings, split, x, quota, jobs, now }: {
  settings: Pick<CrawlSettings, "discover">; split: ReplicaRead<SourceSplit>; x: XStatusView;
  quota: { sources: { quota: unknown; stale: boolean }[] } | null; jobs: EnrichmentJob[]; now: string;
}): FlowNode[] {
  const summary = sourceSummary(split, settings);
  const counts = summary.counts;
  const queries = settings.discover.queries;
  const fresh = quota ? quota.sources.filter((row) => !row.stale && row.quota).length : null;
  const nowMs = Date.parse(now);
  const node = (key: string, value: number | undefined, on: boolean, job: string, io: string): FlowNode => {
    const def = PIPELINE_STAGES.find((row) => row.key === key)!;
    const failed = jobTone(jobs, def.jobs, nowMs);
    const state = !counts ? { tone: "idle" as const, state: "보류" } : failed ?? (!on ? { tone: "idle" as const, state: "꺼짐" }
      : value ? { tone: "ok" as const, state: "흐름" } : { tone: "idle" as const, state: "일감 없음" });
    return { key, label: def.label, code: def.code, ...state, big: counts ? n(value ?? 0) : null, unit: counts ? "이번 시" : summary.note, io: `${intervalWord(job)} · ${io}` };
  };
  const xs = xSummary(x);
  const limit = x.report?.reads.limit;
  const xDef = PIPELINE_STAGES.find((row) => row.key === "x")!;
  return [
    node("github", counts?.github, queries.some((query) => query.enabled), "crawl-seed",
      `검색 신호 ${queries.filter((query) => query.enabled).length}/${queries.length} 켜짐${quota ? ` · GitHub 한도 최신 ${fresh}/${quota.sources.length}` : ""}`),
    node("show-hn", counts?.showHn, settings.discover.showHn.enabled !== false, "hn-show-seed", settings.discover.showHn.requireEvidence ? "AI 흔적 요구" : "흔적 요구 없음"),
    { key: "x", label: xDef.label, code: xDef.code, tone: xs.tone, state: x.state === "unconfigured" || x.state === "missing" ? "연결 전" : xs.value.replace(/^X /, ""),
      big: x.state === "ok" ? n(x.report!.candidates) : null, unit: x.state === "ok" ? "후보" : "",
      io: `하루 1회 · ${limit !== undefined ? `최대 ${n(limit)}건 읽기 · ` : ""}후보만 저장` },
  ];
}

const BARS: Partial<Record<string, (point: HourlySeries["points"][number]) => number>> = {
  judge: (p) => p.judged, first: (p) => p.firstReviews, second: (p) => p.secondReviews, publish: (p) => p.published,
};

/** 심사 흐름 6단계 노드 — 레일과 같은 값(같은 렌더의 throughput · flow), 막대는 시간별 타일과 같은 24시간 */
export function reviewNodes({ throughput, workerProgress, human, flow, hourly, held, slots }: {
  throughput: ThroughputSnapshot | null; workerProgress: WorkerProgressReport | null; human: HumanQueueOverview;
  flow: PipelineFlow; hourly: HourlySeries | null; held: number; slots: SlotRow[];
}): FlowNode[] {
  const dots = reviewDots({ throughput, workerProgress, human });
  const last = hourly?.points.at(-1);
  return REVIEW_STAGES.map((def): FlowNode => {
    const dot = dots.find((row) => row.key === def.key)!;
    const stage = throughput?.stages.find((row) => row.key === def.throughputKey);
    const flowRow = flow.stages.find((row) => row.key === def.flowKey);
    const inOut = flowRow && flowRow.entered !== null && flowRow.left !== null ? ` · 24h 들어옴 ${n(flowRow.entered)} · 나감 ${n(flowRow.left)}` : "";
    const models = slots.filter((slot) => slot.stage === def.key).map((slot) => ({ name: slot.model ? modelName(slot.model) : "설정 없음", title: `${slot.title} · ${slot.model ?? "설정 없음"}`, chip: slot.chip }));
    const modelBad = models.some((model) => model.chip.tone === "bad");
    const tone = dot.tone === "ok" || dot.tone === "idle" ? modelBad ? "bad" : models.some((model) => model.chip.tone === "warn") ? "warn" : dot.tone : dot.tone;
    const state = tone !== dot.tone ? "모델 실패" : dot.text;
    const bars = BARS[def.key] && hourly ? hourly.points.map(BARS[def.key]!) : undefined;
    const five = stage ? `5분 ${n(stage.completed5m)}${stage.unit}` : "5분 미확인";
    const io: Record<string, string> = {
      fetch: `${five}${inOut}`,
      judge: `이번 시 ${last ? n(last.judged) : "—"} · ${five}`,
      first: `이번 시 ${last ? n(last.firstReviews) : "—"} · 실패 ${last && last.firstReviews + last.firstFailed > 0 ? roundPercent(last.firstFailed, last.firstReviews + last.firstFailed) : "—"}`,
      second: `이번 시 ${last ? n(last.secondReviews) : "—"}표 · 1차와 일치 ${last && last.secondReviews > 0 ? roundPercent(last.secondAgreed, last.secondReviews) : "—"}`,
      human: `확정만 ${n(human.stages.agreed)} · ${humanWaitLabel(human)} · ${humanFlowLabel(human)}`,
      publish: `24h ${hourly ? n(hourly.points.reduce((sum, point) => sum + point.published, 0)) : "—"} · 분류 보류 ${n(held)}`,
    };
    return { key: def.key, label: def.label, code: def.code, tone: tone as FlowTone, state,
      big: def.key === "human" ? n(human.stages.human) : stage ? n(stage.waiting) : null, unit: def.key === "human" ? "직접 판단" : "대기",
      io: io[def.key] ?? "", bars, models: def.key === "judge" ? [{ name: `규칙판 ${REVIEW_RULES_VERSION}`, title: "규칙 판정 판(REVIEW_RULES_VERSION)", chip: { tone: undefined, text: "" } }] : models };
  });
}

/** 보강 노드 — 12칸은 그대로, 나머지는 "그 밖의 보강" 한 칸으로 묶는다. 칸마다 그 단계의 모델(설정)·24h 결과(복제본) */
export function enrichmentFlowNodes(nodes: EnrichmentNode[], slots: SlotRow[]): FlowNode[] {
  const withModels = (node: EnrichmentNode): FlowNode => ({ key: node.key, label: node.label, code: node.code, tone: node.tone, state: node.state,
    big: node.value, unit: "", io: node.note,
    models: slots.filter((slot) => slot.stage === node.key).map((slot) => ({ name: slot.model ? modelName(slot.model) : "설정 없음",
      title: `${slot.title} · ${slot.model ?? "설정 없음"}`, chip: slot.chip })) });
  const others = nodes.filter((node) => !node.headline);
  const flagged = others.filter((node) => node.tone === "warn" || node.tone === "bad");
  return [...nodes.filter((node) => node.headline).map(withModels),
    { key: "others", label: "그 밖의 보강", code: others.map((node) => node.code).join(" · "), tone: worstTone(...others.map((node) => node.tone)),
      state: flagged.length ? `주의 ${flagged.length}` : "흐름", big: n(others.length), unit: "단계", io: others.map((node) => node.label).join(" · ") }];
}

/** 처음 열 노드 — 흐름 차례(소스 → 심사 → 보강)로 빨강, 없으면 주황, 없으면 원본 수집 */
export function defaultNode(nodes: FlowNode[]): string {
  return (nodes.find((node) => node.tone === "bad") ?? nodes.find((node) => node.tone === "warn") ?? nodes.find((node) => node.key === "fetch") ?? nodes[0])?.key ?? "fetch";
}
