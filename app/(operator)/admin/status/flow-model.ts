import type { HumanQueueOverview } from "@/lib/crawl/human-queue";
import { sameReviewModel } from "@/lib/crawl/review-model-identity";
import { SHOW_HN_SIGNAL, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { formatAgo, formatDetailTime } from "@/lib/format/time";
import { isPausedJob } from "@/lib/jobs/status";
import type { AttentionCounts } from "@/lib/operations/dashboard";
import type { EvidenceVerdicts, SourceSplit } from "@/lib/operations/flow-reads";
import type { PipelineControlStatus } from "@/lib/operations/pipeline-control-status";
import { replicaHoldText, type ReplicaRead } from "@/lib/operations/replica-hold";
import type { SearchHealth } from "@/lib/operations/search-health-model";
import { PIPELINE_STAGES, resolveModelSlots, type ModelSlot } from "@/lib/operations/stage-registry";
import type { ThroughputSnapshot } from "@/lib/operations/throughput-model";
import type { StageProgress } from "@/lib/operations/worker-progress";
import type { WorkerProgressReport } from "@/lib/operations/worker-progress-query";
import type { XStatusView } from "@/lib/operations/x-status";
import type { ActionItem, SplitItem } from "./dashboard/AttentionList";
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
 * 모델 카드 네 줄(1차 · 2차 투표 · 2차 예비 · 키워드 짓기)이 보이지 않는 자리 — 카드의 2차 투표는 1차와 다른 첫 투표자다(modelHealth 와 같다).
 */
export function otherModelSlots(settings: Pick<CrawlSettings, "firstReview" | "secondReview">, env: Readonly<Record<string, string | undefined>> = process.env): ModelSlot[] {
  const first = settings.firstReview?.model ?? null;
  const voter = settings.secondReview.voters.findIndex((row) => !sameReviewModel(row.model, first));
  const card = new Set(["first", "keywords", "second-fallback-1", ...(voter >= 0 ? [`second-voter-${voter + 1}`] : [])]);
  return resolveModelSlots(settings, env).filter((slot) => !card.has(slot.key));
}
