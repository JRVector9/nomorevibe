import { claimUptimeProducts, readUptimeSplitControl, releaseUptimeClaims, submitUptimeResults, UptimeClaimOwnerSchema,
  type UptimeClaimBatch, type UptimeClaimOwner, type UptimeClaimTicket, type UptimeResult } from "@/lib/domain/products/uptime-claims";
import { uptimeSplitHostEntry, type UptimeSplitHost } from "@/lib/domain/products/uptime-split-policy";
import { FETCH_TIMEOUT_MS, safeFetch } from "@/lib/net/fetch";
import { logger } from "@/lib/observability/logger";
import { observe } from "@/lib/operations/observations";
import { interruptibleSleep, type RuntimeReport } from "@/scripts/worker";

/**
 * split-v1 제품 연결 확인 consumer(design-uptime §7.2). 역할 lease 없이 uptime_claims 를 묶음으로 claim 해 확인하고, 결과를 claim 행에
 * 묶음으로 제출만 한다. 정식 기록(product_health·일일 집계·연속 실패·내림)은 home 의 uptime-ping 적용기가 쓴다.
 *
 * - pacing: 정책의 내 항목(maxPerHour·batch·concurrency)을 따른다. 확인 시작을 3600초/maxPerHour 간격으로 고르게 벌리고,
 *   동시에 여는 서버는 concurrency 까지다. 같은 사이트(origin)는 한 줄로 묶어 차례로 연다 — 다른 owner 와는 claim 의 origin 배타가 막는다.
 * - claim 은 TTL 안에 시작할 수 있는 만큼만 한다. lease 끝에서 (확인 한도 + 제출 주기 + 여유) 전까지 시작하지 못한 티켓은 열지 않고
 *   돌려준다 — 만료 뒤 다른 owner 가 다시 잡은 제품을 두 번 두드리지 않는다.
 * - 본문은 읽지 않는다(§6). 응답 헤더를 받으면 본문을 취소한다. 텍스트 표본은 home 자기 확인만 만든다(지역화 본문이 재검사를 흔들지 않게).
 * - 25건 또는 5초마다 제출한다. 제출이 거절되거나 control epoch 이 바뀌면 그 묶음을 버리고(진행 중 결과도) 다시 읽는다.
 * - legacy·정책에 없음·차단기 open 이면 claim 하지 않고 쉰다. 쉬는 동안에도 감독 진행 기한(90초) 안에 report('idle') 한다.
 * - 종료(SIGTERM → abort): 새 확인을 시작하지 않고, 진행 중 확인을 마쳐 제출한 뒤, 받아들여지지 않은 티켓을 돌려준다.
 * - 공유 HTTP permit(전역 http_origin_control)은 쓰지 않는다(§4). 진입점이 HTTP_ORIGIN_PERMITS=1 을 거절한다.
 */

const JOB = "uptime-consumer";
const SUBMIT_BATCH = 25;
const SUBMIT_EVERY_MS = 5_000;
const IDLE_MS = 10_000;
const OBSERVE_EVERY_MS = 30_000;
const WINDOW_MS = 5 * 60_000;
/** 긴 기다림은 이 단위로 끊어 감독 진행 기한(WORKER_PROGRESS_TIMEOUT_SECONDS 90초) 안에 살아 있음을 알린다 */
const SLICE_MS = 30_000;
/** 마지막으로 시작한 확인이 끝나고(10초) 다음 제출 주기(5초)에 실려 commit 될 때까지의 여유 */
export const UPTIME_CONSUMER_LEASE_MARGIN_MS = FETCH_TIMEOUT_MS + SUBMIT_EVERY_MS + 5_000;

export type UptimeCheck = Pick<UptimeResult, "startedAt" | "observedAt" | "kind" | "status" | "latencyMs"> & { elapsedMs: number };
export type UptimeConsumerIdle = "mode_legacy" | "source_unconfigured" | "pacing_unconfigured" | "host_mismatch"
  | "site_fenced" | "breaker_open" | "empty";
export type UptimeConsumerSummary = { batches: number; claimed: number; checked: number; accepted: number; lost: number; released: number };
type Claimed = Extract<UptimeClaimBatch, { kind: "claimed" }>;
type Pacing = { maxPerHour: number; batch: number; concurrency: number };

/**
 * 본문을 읽지 않는 확인. 생존은 최종 응답 상태로만 본다(legacy 와 같은 safeFetch background: hop 마다 SSRF 검사, 리다이렉트 5번, 전체 10초).
 * 연결 실패·차단·한도 초과는 unknown/0 이다. 100..599 밖의 비표준 상태도 결과 모양에 담을 수 없어 unknown/0 으로 둔다(실패로 보는 것은 같다).
 */
export async function checkUptimeUrl(url: string): Promise<UptimeCheck> {
  const startedAt = new Date(), started = performance.now();
  const fetched = await safeFetch(url, "background");
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  const status = fetched?.response.status ?? 0;
  // 열린 본문 스트림을 닫아야 연결과 origin 자리(acquireOrigin)가 돌아간다
  await fetched?.response.body?.cancel().catch(() => {});
  const http = fetched !== null && status >= 100 && status <= 599;
  return { startedAt, observedAt: new Date(), kind: http ? "http" : "unknown", status: http ? status : 0, latencyMs: http ? elapsedMs : null, elapsedMs };
}

/** 확인 시작 간격(ms) */
export function uptimeConsumerInterval(maxPerHour: number): number {
  return Math.ceil(3_600_000 / maxPerHour);
}
/** 한 번에 claim 할 수: 정책 batch, 그리고 이 간격으로 lease 끝 여유 전까지 시작할 수 있는 수 중 작은 것(최소 1) */
export function uptimeConsumerClaimLimit(batch: number, ttlMs: number, intervalMs: number): number {
  return Math.max(1, Math.min(batch, Math.floor((ttlMs - UPTIME_CONSUMER_LEASE_MARGIN_MS) / intervalMs) + 1));
}
/** probe 는 schema 가 셋 다 요구한다. home 항목도 이 consumer 로 돌리려면 셋 다 있어야 한다(상한 없이 돌지 않는다) */
function pacingOf(entry: UptimeSplitHost): Pacing | null {
  const { maxPerHour, batch, concurrency } = entry;
  return maxPerHour !== undefined && batch !== undefined && concurrency !== undefined ? { maxPerHour, batch, concurrency } : null;
}

/** 확인 시작을 간격대로 줄 세운다. 자리는 부르는 순간 동기적으로 잡으므로 작업자 여럿이 같은 자리를 받지 않는다(단조 시계) */
function pacer() {
  let last = -Infinity;
  const until = async (at: number, signal: AbortSignal | undefined, tick: () => void) => {
    for (let left = at - performance.now(); left > 0 && !signal?.aborted; left = at - performance.now()) {
      tick();
      await interruptibleSleep(Math.min(left, SLICE_MS), signal);
    }
  };
  return {
    /** 다음 자리까지 기다리기만 한다 — claim 전에 불러 lease 시간을 기다림에 쓰지 않는다 */
    ready: (intervalMs: number, signal: AbortSignal | undefined, tick: () => void) => until(last + intervalMs, signal, tick),
    take: (intervalMs: number, signal: AbortSignal | undefined, tick: () => void) => {
      const at = Math.max(performance.now(), last + intervalMs);
      last = at;
      return until(at, signal, tick);
    },
  };
}

/** 최근 5분 관측(canary 측정: 오사카 지연·403·timeout 비율, Oracle↔DB 왕복, CPU·RSS) */
function consumerStats() {
  type Check = { at: number; kind: UptimeCheck["kind"]; status: number; elapsedMs: number; latencyMs: number | null };
  const samples = { claimed: [] as { at: number; n: number }[], accepted: [] as { at: number; n: number }[], lost: [] as { at: number; n: number }[],
    released: [] as { at: number; n: number }[], read: [] as { at: number; n: number }[], claim: [] as { at: number; n: number }[],
    submit: [] as { at: number; n: number }[], checks: [] as Check[] };
  const last = { claimAt: null as string | null, submitAt: null as string | null };
  let cpu = process.cpuUsage(), cpuAt = performance.now();
  const prune = (now: number) => {
    for (const list of Object.values(samples)) while (list.length && list[0].at < now - WINDOW_MS) list.shift();
  };
  const sum = (list: { n: number }[]) => list.reduce((total, item) => total + item.n, 0);
  const pick = (values: number[], ratio: number) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return Math.round(sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)]);
  };
  return {
    add(name: "claimed" | "accepted" | "lost" | "released", n: number) {
      samples[name].push({ at: performance.now(), n });
      if (name === "claimed") last.claimAt = new Date().toISOString();
      if (name === "accepted") last.submitAt = new Date().toISOString();
    },
    check(value: UptimeCheck) {
      samples.checks.push({ at: performance.now(), kind: value.kind, status: value.status, elapsedMs: value.elapsedMs, latencyMs: value.latencyMs });
    },
    /** DB 왕복을 잰다. read(제어 행 SELECT 1문장)가 Oracle↔DB 왕복 1회에 가깝다 */
    async timed<T>(name: "read" | "claim" | "submit", work: () => Promise<T>): Promise<T> {
      const started = performance.now();
      const value = await work();
      samples[name].push({ at: performance.now(), n: performance.now() - started });
      return value;
    },
    snapshot() {
      const now = performance.now();
      prune(now);
      const checks = samples.checks, negatives = checks.filter(item => item.kind !== "http" || item.status < 200 || item.status >= 400);
      const latencies = checks.flatMap(item => item.latencyMs === null ? [] : [item.latencyMs]);
      const usage = process.cpuUsage(cpu), wall = now - cpuAt;
      cpu = process.cpuUsage(); cpuAt = now;
      const tx = (name: "read" | "claim" | "submit", ratio: number) => pick(samples[name].map(item => item.n), ratio);
      return {
        claimed5m: sum(samples.claimed), checked5m: checks.length, accepted5m: sum(samples.accepted), lost5m: sum(samples.lost),
        released5m: sum(samples.released), negatives5m: negatives.length, forbidden5m: checks.filter(item => item.status === 403).length,
        // 응답 없이 10초 한도에 닿은 실패(DNS·연결·읽기 지연 포함)
        timeouts5m: negatives.filter(item => item.kind !== "http" && item.elapsedMs >= FETCH_TIMEOUT_MS - 100).length,
        ratePerHour: Math.round(checks.length * (3_600_000 / WINDOW_MS)), latencyP50Ms: pick(latencies, 0.5), latencyP90Ms: pick(latencies, 0.9),
        dbReadP50Ms: tx("read", 0.5), claimTxP50Ms: tx("claim", 0.5), claimTxP95Ms: tx("claim", 0.95),
        submitTxP50Ms: tx("submit", 0.5), submitTxP95Ms: tx("submit", 0.95), lastClaimAt: last.claimAt, lastSubmitAt: last.submitAt,
        rssBytes: process.memoryUsage().rss, cpuPercent: wall > 0 ? Math.round((usage.user + usage.system) / 10 / wall) : null,
      };
    },
  };
}

/** 같은 서버(origin)의 티켓을 한 줄로 묶는다(legacy byOrigin 과 같은 규칙). 순서는 claim 순서 그대로다 */
function byOrigin(tickets: readonly UptimeClaimTicket[]): UptimeClaimTicket[][] {
  const lanes = new Map<string, UptimeClaimTicket[]>();
  for (const ticket of tickets) {
    const origin = URL.parse(ticket.url)?.origin ?? ticket.url;
    const lane = lanes.get(origin);
    if (lane) lane.push(ticket);
    else lanes.set(origin, [ticket]);
  }
  return [...lanes.values()];
}

/** 넘긴 일을 들어온 순서대로 하나씩 실행한다(제출·제어 읽기가 연결 하나만 쓰게) */
function oneAtATime() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work);
    tail = run.catch(() => {});
    return run;
  };
}

export async function runUptimeConsumer(input: {
  owner: UptimeClaimOwner; signal?: AbortSignal; report?: RuntimeReport; once?: boolean;
  /** PHYSICAL_HOST. 있으면 정책이 이 instance 를 다른 host 로 옮겼을 때 claim 하지 않는다(이 host 의 실패가 다른 class 로 세지 않게) */
  physicalHost?: string;
  /** 확인 함수. 기본은 checkUptimeUrl(본문 없음) */
  check?: (ticket: UptimeClaimTicket) => Promise<UptimeCheck>;
}): Promise<UptimeConsumerSummary> {
  const owner = UptimeClaimOwnerSchema.parse(structuredClone(input.owner)), { signal, report, once } = input;
  const check = input.check ?? ((ticket: UptimeClaimTicket) => checkUptimeUrl(ticket.url));
  const summary: UptimeConsumerSummary = { batches: 0, claimed: 0, checked: 0, accepted: 0, lost: 0, released: 0 };
  const stats = consumerStats(), pace = pacer();
  const view = { state: "starting" as "starting" | "running" | "idle" | "stopped", reason: null as string | null, host: null as string | null,
    class: null as string | null, controlEpoch: null as number | null, breaker: null as string | null, pacing: null as Pacing | null };
  // 운영센터·canary 가 읽는 관측 키. 실패해도 확인은 멈추지 않는다
  const publish = () => observe(`uptime-consumer:${owner.instanceId}`, { ...view, bootId: owner.bootId, ...stats.snapshot() }).catch(() => {});
  const observer = setInterval(() => { void publish(); }, OBSERVE_EVERY_MS);
  observer.unref();
  const rest = async (reason: UptimeConsumerIdle) => {
    if (view.reason !== reason) logger.info("uptime_consumer.idle", { reason, controlEpoch: view.controlEpoch });
    view.state = "idle"; view.reason = reason;
    report?.("idle");
    if (!once) await interruptibleSleep(IDLE_MS, signal);
  };
  const release = async (claims: readonly UptimeClaimTicket[]) => {
    if (!claims.length) return;
    const released = await releaseUptimeClaims({ owner, claims });
    if (released.kind === "released") { summary.released += released.released.length; stats.add("released", released.released.length); }
  };

  /** 한 묶음: 간격·동시 수대로 확인하고 25건·5초마다 제출, 끝나면(종료·폐기 포함) 받아들여지지 않은 티켓을 돌려준다 */
  const runBatch = async (batch: Claimed, pacing: Pacing, intervalMs: number, deadline: number) => {
    const startedAt = performance.now(), lanes = byOrigin(batch.claims), accepted = new Set<number>(), serial = oneAtATime();
    let pending: UptimeResult[] = [], abandoned: string | null = null, failure: unknown = null;
    const abandon = (reason: string) => {
      if (abandoned) return;
      abandoned = reason; pending = [];
      logger.info("uptime_consumer.abandoned", { reason, controlEpoch: batch.controlEpoch });
    };
    const submit = async () => {
      if (abandoned || !pending.length) return;
      const results = pending;
      pending = [];
      const outcome = await stats.timed("submit", () => submitUptimeResults({ owner, results }));
      if (outcome.kind === "blocked") {
        summary.lost += results.length; stats.add("lost", results.length);
        return abandon(outcome.reason);
      }
      for (const id of outcome.accepted) accepted.add(id);
      summary.accepted += outcome.accepted.length; summary.lost += outcome.lost.length;
      stats.add("accepted", outcome.accepted.length); stats.add("lost", outcome.lost.length);
      if (outcome.controlEpoch !== batch.controlEpoch) abandon("control_epoch");
    };
    // 제출할 것이 없으면 제어 행을 다시 읽는다 — epoch·mode 변경을 5초 안에 알아 그 뒤 결과를 버린다
    const watch = async () => {
      if (abandoned) return;
      if (pending.length) return submit();
      const control = await stats.timed("read", () => readUptimeSplitControl());
      if (control.epoch !== batch.controlEpoch || control.mode !== "claims") abandon("control_epoch");
    };
    const run = (work: () => Promise<void>) => serial(work).catch(error => { failure ??= error; });
    const stopped = () => Boolean(signal?.aborted) || abandoned !== null || failure !== null;
    const timer = setInterval(() => { void run(watch); }, SUBMIT_EVERY_MS);
    try {
      await Promise.all(Array.from({ length: Math.min(pacing.concurrency, lanes.length) }, async () => {
        for (let lane = lanes.shift(); lane; lane = lanes.shift()) {
          for (const ticket of lane) {
            if (stopped()) return;
            await pace.take(intervalMs, signal, () => report?.("idle"));
            // 종료·폐기·lease 끝 여유를 넘긴 티켓은 열지 않는다(아래에서 돌려준다)
            if (stopped() || performance.now() > deadline) return;
            report?.("running", JOB, Date.now());
            let checked: UptimeCheck;
            try { checked = await check(ticket); }
            catch (error) { failure ??= error; return; }
            summary.checked++; stats.check(checked);
            if (abandoned) continue;
            pending.push({ productId: ticket.productId, token: ticket.token, epoch: ticket.epoch, startedAt: checked.startedAt,
              observedAt: checked.observedAt, kind: checked.kind, status: checked.status, latencyMs: checked.latencyMs });
            if (pending.length >= SUBMIT_BATCH) void run(submit);
          }
        }
      }));
    } finally {
      clearInterval(timer);
      // 진행 중이던 확인까지 제출한 뒤, 받아들여지지 않은 티켓(열지 않음·버림·거절)을 풀로 돌려준다. lost 는 이미 남의 것이라 바뀌지 않는다
      await run(submit);
      await release(batch.claims.filter(ticket => !accepted.has(ticket.productId))).catch(error => { failure ??= error; });
      logger.info("uptime_consumer.batch", { claimed: batch.claims.length, accepted: accepted.size, abandoned,
        durationMs: Math.round(performance.now() - startedAt), controlEpoch: batch.controlEpoch, breaker: batch.breaker });
    }
    if (failure) throw failure;
  };

  const round = async () => {
    report?.("polling");
    const control = await stats.timed("read", () => readUptimeSplitControl());
    view.controlEpoch = control.epoch;
    const policy = control.mode === "claims" ? control.policy : null;
    if (!policy) return rest("mode_legacy");
    const entry = uptimeSplitHostEntry(policy, owner.instanceId);
    if (!entry) return rest("source_unconfigured");
    const pacing = pacingOf(entry);
    view.host = entry.host; view.class = entry.class; view.pacing = pacing;
    if (!pacing) return rest("pacing_unconfigured");
    if (input.physicalHost !== undefined && input.physicalHost !== entry.host) return rest("host_mismatch");
    const intervalMs = uptimeConsumerInterval(pacing.maxPerHour);
    await pace.ready(intervalMs, signal, () => report?.("idle"));
    if (signal?.aborted) return;
    // lease 끝은 claim 을 보내기 전 시각으로 잰다 — DB 의 claimed_at 은 이보다 늦으므로 보수적이다(host·DB 시계 차와 무관)
    const deadline = performance.now() + policy.claim.ttlMs - UPTIME_CONSUMER_LEASE_MARGIN_MS;
    const batch = await stats.timed("claim", () => claimUptimeProducts({ owner,
      limit: uptimeConsumerClaimLimit(pacing.batch, policy.claim.ttlMs, intervalMs) }));
    if (batch.kind === "blocked") {
      if (batch.reason === "breaker_open") view.breaker = "open";
      return rest(batch.reason);
    }
    view.breaker = batch.breaker;
    if (!batch.claims.length) return rest("empty");
    summary.batches++; summary.claimed += batch.claims.length; stats.add("claimed", batch.claims.length);
    // 읽은 뒤 claim 사이에 정책이 바뀌었으면 이 pacing·TTL 로 돌지 않는다
    if (batch.controlEpoch !== control.epoch) return release(batch.claims);
    view.state = "running"; view.reason = null;
    await runBatch(batch, pacing, intervalMs, deadline);
  };

  try {
    while (!signal?.aborted) {
      await round();
      if (once) break;
    }
  } finally {
    clearInterval(observer);
    view.state = "stopped";
    await publish();
  }
  return summary;
}
