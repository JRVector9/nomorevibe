import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { db } from "@/lib/db";
import { uptimeSplitControl } from "@/lib/db/product-uptime-schema";
import { refreshTextSample } from "@/lib/crawl/repository";
import { nextToCheck, recordPing, type PingTarget } from "@/lib/domain/products/health";
import { isUnknownUptimeStatus } from "@/lib/domain/products/health-record";
import { uptimeSlot } from "@/lib/domain/products/uptime-policy";
import { uptimeObservationMode, uptimeObserverSource, nextUptimeObservationTargets, recordUptimeObservation } from "@/lib/domain/products/uptime-observations";
import { autoBanUptimeProduct, nextUptimeAutoBanTargets } from "@/lib/domain/products/uptime-auto-ban";
import { applyUptimeResults, type UptimeApplySummary, type UptimeOwnResult } from "@/lib/domain/products/uptime-apply";
import { claimUptimeProducts, readUptimeSplitControl, releaseUptimeClaims, syncUptimeClaimRows, type UptimeClaimTicket } from "@/lib/domain/products/uptime-claims";
import { UPTIME_BROAD_FAILURE_MIN_CHECKS, UPTIME_BROAD_FAILURE_RATIO, uptimeSplitHostEntry } from "@/lib/domain/products/uptime-split-policy";
import { serviceInstanceId } from "@/lib/operations/instance";
import { checkUptime, runOriginLanes } from "./uptime-check";

/**
 * 생존 확인 잡.
 *
 * 등재된 제품이 아직 떠 있는지 본다. 죽은 링크가 목록에 남아 있으면 "직접 확인한 것만
 * 보여준다"는 말이 무의미해진다.
 *
 * 최근 연속 실패가 10회에 이르면 현재 제품·주소·관측을 다시 확인한 뒤 자동으로 내리고
 * 이력을 남긴다. 기존 최근 적체도 같은 배치·예산 안에서 처리한다.
 *
 * 여는 김에 본문 앞부분도 담아 둔다. 판정 규칙이 본문을 보게 됐는데(설치 유도 아님)
 * 이미 발행된 것들은 그 값이 없던 시절에 수집됐다. 같은 주소를 어차피 여기서 여니
 * 새 요청 없이 채워진다 — 그래야 발행분 재검수가 지금 기준으로 다시 태운다.
 *
 * 한 바퀴가 재확인 간격(6시간)을 따라가야 한다. 약 19,365개 공개 웹사이트에는
 * 분당 54건 이상이 필요하다. 기본 15건/분은 기존 작은 규모에 맞고 현재 규모에는 부족하다.
 * 용량 상향은 환경 설정으로 한 역할씩 측정하며 진행한다.
 *
 * 2026-10-07 공개 웹사이트가 3만6천 개가 되자 분당 100건이 필요해졌는데 상한(60건·동시 6)에 붙어
 * 시간당 3,600건만 봤다 — 6시간 넘게 밀린 제품이 1만2천을 넘었다. 한 틱 60건은 11초에 끝나 예산(25초)이
 * 남았으므로 상한을 200건·동시 16으로 올리고 운영은 150건·동시 12로 둔다(밀린 몫까지 따라잡는다).
 *
 * 주기를 당긴 만큼 한 틱이 늘어지면 안 된다. 순차로 열면 응답 없는 서버 하나가 10초를 먹어
 * 25초 예산에 두세 건밖에 못 본다. 그래서 서로 다른 서버를 CONCURRENCY곳까지 동시에 연다.
 * 응답이 느리면 25초 예산이 먼저 끝나므로 설정값이 곧 실제 처리량이라는 뜻은 아니다.
 *
 * 남의 서버를 두드리지 않는다는 원칙은 동시에 열어도 그대로다. 같은 서버(origin)는 한 번에
 * 하나씩만 열고, 제품마다 6시간에 한 번이라는 제한(nextToCheck)도 그대로라 한 서버가 받는
 * 요청은 늘지 않는다 — 밀린 몫을 빨리 따라잡을 뿐이다.
 *
 * 커서가 없다. 확인한 지 오래된 것부터 가져오므로 확인 시각 자체가 진행 지점이다.
 *
 * 2026-10-19 연속 실패 카운터가 매번 1로 돌아가던 버그(health.ts recordPing)를 고치면서 광역 실패 보류를 넣었다.
 * 이 잡이 본 실패는 이 서버(M3)에서 본 것이라, 이 서버의 네트워크·DNS가 끊기면 공개 제품 전체가 한꺼번에
 * 실패로 세어져 숨겨진다. 그래서 실패 기록만 틱 끝까지 모아 두고, 한 틱에 BROAD_FAILURE_MIN_ATTEMPTS건 이상
 * 확인했는데 실패가 BROAD_FAILURE_RATE를 넘으면 그 틱의 실패는 세지 않는다. 성공은 바로 쓴다.
 * 세지 않은 제품은 "확인은 했지만 판정 보류"로 확인 시각만 넘겨 다른 제품처럼 6시간 뒤 차례를 기다린다
 * (연속 실패·일별 집계·숨김·내림은 그대로, health-record writeHealthHeld). 시각을 그대로 두면 가장 오래된 채로
 * 다음 틱 배치를 먼저 채워, 부분 장애가 이어지면 몇 틱 만에 배치 전체가 보류 제품이 되고 다른 제품 확인이 멈추며
 * 막힌 사이트는 1분마다 요청을 받았다.
 *
 * 2026-10-19 split-v1(제품 단위 분담, 0103)이 claims 모드면 같은 잡이 claim 경로로 돈다(design-uptime §7.1). 틱마다
 * 제출분 반영(Oracle 등) → 내림 적체 sweep → 새 제품 행 → home claim → 확인 → 틱 결과를 한 번에 반영한다. 판정은
 * 묶음 적용기(uptime-apply.ts)가 하고, 광역 실패는 host 차단기가 막는다(묶음 기준은 legacy 보류와 같은 30건·30%).
 * legacy 모드면 아래 경로가 그대로다. 모드는 틱 시작에 한 번 읽는다 — 전환은 다음 틱부터다.
 */

/**
 * 한 틱에 확인하는 수의 상한. 예산(25초)이 먼저 끝나면 거기서 멈추고, 남은 것은 가장
 * 오래된 채로 남아 다음 틱이 먼저 가져간다.
 */
const DEFAULT_BATCH = 15;

/**
 * 한 틱 안에서 동시에 여는 서버 수.
 *
 * HTTP만 동시에 연다. 기록(DB 쓰기)은 한 번에 하나씩 줄을 세운다 — 기록은 밀리초라 느려지지
 * 않고, 그래야 이 잡이 동시에 쥐는 DB 연결이 기록 1 + 러너 임대 갱신 1 = 2로 묶여
 * maintenance 풀(3) 안에 든다. 기록까지 동시에 하면 3 + 1 = 4로 풀을 넘는다.
 */
const DEFAULT_CONCURRENCY = 3;

/**
 * 광역 실패 보류 기준(UPTIME_BROAD_FAILURE_*, uptime-split-policy.ts). 평소 하루 실패는 확인의 0.6~1.8%다(2026-10-14~18) —
 * 한 틱의 30%를 넘는 실패는 사이트가 아니라 이 서버 쪽 문제로 본다. 표본이 너무 작으면 몇 건만 죽어도 비율이 튀므로 30건부터 판단한다.
 * split claims 모드의 묶음 규칙(policy batchMin·batchOpenRatio)도 같은 값이다.
 */
const BROAD_FAILURE_MIN_ATTEMPTS = UPTIME_BROAD_FAILURE_MIN_CHECKS;
const BROAD_FAILURE_RATE = UPTIME_BROAD_FAILURE_RATIO;

function capacitySetting(env: Readonly<Record<string, string | undefined>>, key: string, fallback: number, max: number) {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`Invalid ${key}: expected integer 1..${max}`);
  }
  return value;
}

/** Bounded maintenance-only ramp; defaults preserve the existing request rate. */
export function uptimeCapacityConfig(env: Readonly<Record<string, string | undefined>> = process.env) {
  return { batch: capacitySetting(env, "UPTIME_BATCH_SIZE", DEFAULT_BATCH, 200),
    concurrency: capacitySetting(env, "UPTIME_CONCURRENCY", DEFAULT_CONCURRENCY, 16) };
}

export async function pingProducts(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const capacity = uptimeCapacityConfig();
  const observationMode = await uptimeObservationMode();
  // PR09 관측·gate 가 켜져 있으면 split 은 legacy 다(0103 트리거가 함께 켜지 못하게 막는다) — 그때는 split 행을 읽지 않는다
  // (Oracle product-health 관측자 principal 에는 그 표 권한이 없다). policy 는 claims 경로가 검증한다(hash 가 틀리면 그쪽이 멈춘다)
  if (!observationMode.observationsEnabled && !observationMode.gateEnabled) {
    const [split] = await db.select({ mode: uptimeSplitControl.mode }).from(uptimeSplitControl).where(eq(uptimeSplitControl.id, 1));
    if (split?.mode === "claims") return pingClaimed(ctx, capacity);
  }
  const source = observationMode.observationsEnabled ? uptimeObserverSource(observationMode.sources) : null;
  const raw = source ? { source, gateEnabled: observationMode.gateEnabled } : null;
  const write = oneAtATime();
  let autoBanned = 0;
  let swept = 0;
  const backlog = raw?.source.host === "oracle-osaka-smoke" && !raw.gateEnabled ? [] : await nextUptimeAutoBanTargets(capacity.batch);
  for (const target of backlog) {
    if (ctx.signal?.aborted || !ctx.hasBudget()) break;
    swept++;
    if (await write(() => autoBanUptimeProduct(target, ctx))) autoBanned++;
  }
  const targets = swept < capacity.batch && !ctx.signal?.aborted ? await (source ? nextUptimeObservationTargets(capacity.batch - swept, source) : nextToCheck(capacity.batch - swept)) : [];
  if (targets.length === 0) {
    ctx.log(backlog.length ? "uptime.checked" : "uptime.idle", { checked: 0, autoBanned });
    return { done: backlog.length === 0 };
  }

  let alive = 0;
  let down = 0;
  /** 봇·로그인 차단 응답(401·403·429·999) — 살았는지 알 수 없어 세지 않고 바로 기록한다 */
  let unknown = 0;
  /** legacy 실패 기록 — 틱 끝에 광역 실패인지 본 뒤 센다(record) 또는 판정을 보류한다(hold) */
  const failures: DeferredFailure[] = [];

  const errors = await runOriginLanes(targets, capacity.concurrency, () => !ctx.signal?.aborted && ctx.hasBudget(), async target => {
    const result = await ping(target, write, ctx, () => { autoBanned++; }, raw, failure => { failures.push(failure); });
    if (result === "up") alive++;
    else if (result === "unknown") unknown++;
    else down++;
  });

  // 이미 본 결과라 예산이 끝났거나 앞에서 한 건이 실패했어도 쓴다(성공과 같다). 광역 실패면 세지 않고 확인 시각만 넘긴다.
  // 첫 쓰기 실패에서 멈추고 나머지는 다음 틱이 다시 본다
  // 알 수 없는 응답은 성공이 아니므로 비율에서는 실패 쪽에 센다 — 이전처럼 분모·분자에 그대로 둬 보류가 느슨해지지 않는다.
  // 평소에는 공개 제품의 0.04%라 비율을 거의 움직이지 않고, 한 틱에 몰리면 이 서버가 막힌 것(IP 평판·CDN 한도)이라
  // 같은 틱의 다른 실패도 믿기 어렵다. 분모에서 빼면 표본이 30건 아래로 줄어 보류가 아예 꺼질 수 있다.
  const attempted = alive + down + unknown;
  const held = failures.length > 0 && attempted >= BROAD_FAILURE_MIN_ATTEMPTS
    && (failures.length + unknown) / attempted > BROAD_FAILURE_RATE;
  if (held) ctx.log("uptime.broad_failure_held", { attempted, down: failures.length, unknown });
  for (const failure of failures) {
    try {
      await write(held ? failure.hold : failure.record);
    } catch (error) {
      errors.push(error);
      break;
    }
  }
  if (errors.length > 0) throw errors[0];

  ctx.log("uptime.checked", { alive, down, unknown, autoBanned });
  // 한 바퀴를 다 돌았는지는 여기서 알 수 없다 — 오래된 것부터 계속 가져오면 그만이다
  return { done: false };
}

/** 이 프로세스의 claim owner boot. 잡이 틱마다 같은 owner 로 claim·되돌림을 한다 */
const BOOT_ID = randomUUID();

/** 적용 요약 중 운영 관측에 남길 수(runner 는 숫자만 남긴다) */
function appliedCounts(summary: UptimeApplySummary) {
  const { outcomes } = summary;
  return { remote: summary.remote, applied: outcomes.applied, held: outcomes.held, confirmRequested: outcomes.confirm_requested,
    returned: outcomes.returned, stale: outcomes.stale, lost: outcomes.lost, discarded: outcomes.discarded,
    conflicts: summary.conflicts, autoBanned: summary.autoBanned };
}

/**
 * split claims 모드 한 틱(design-uptime §7.1, U1b 호출 순서). 정식 기록은 모두 묶음 적용기(applyUptimeResults)가 쓴다.
 * 1) 제출분 반영 — 결과가 없어도 틱마다 불러 차단기를 시간에 따라 진행시킨다(open → probing).
 * 2) 내림 적체 sweep(legacy 와 같다) 3) 새 공개 제품의 claim 행 4) home claim(재확인 요청 먼저)
 * 5) 확인(legacy 와 같은 HTTP·본문·서버 직렬) 6) 틱의 결과를 한 번에 반영 — 묶음 광역 규칙이 성공까지 포함한 틱 전체를 본다
 *    (나눠 넣으면 실패만 모인 묶음이 언제나 광역으로 보이거나, 30건에 영영 못 닿는다).
 * 7) 반영하지 못한(열지 않았거나 적용이 실패한) claim 은 풀로 돌려준다 — 다음 틱이 바로 다시 가져간다.
 */
async function pingClaimed(ctx: JobContext<null>, capacity: ReturnType<typeof uptimeCapacityConfig>): Promise<JobOutcome<null>> {
  if (!ctx.lease) throw new Error("uptime_job_required");
  const lease = ctx.lease, signal = ctx.signal;
  const remote = await applyUptimeResults({ lease, signal, hasBudget: ctx.hasBudget });
  if (remote.remote > 0) ctx.log("uptime.split_applied", appliedCounts(remote));
  // 그 사이 legacy 로 돌아갔으면 다음 틱이 legacy 로 돈다
  if (remote.mode !== "claims") return { done: false };

  let autoBanned = remote.autoBanned;
  let swept = 0;
  const backlog = await nextUptimeAutoBanTargets(capacity.batch);
  for (const target of backlog) {
    if (signal?.aborted || !ctx.hasBudget()) break;
    swept++;
    if (await autoBanUptimeProduct(target, ctx)) autoBanned++;
  }
  await syncUptimeClaimRows({ lease });
  const idle = () => { ctx.log(backlog.length ? "uptime.checked" : "uptime.idle", { checked: 0, autoBanned }); return { done: backlog.length === 0 }; };
  if (swept >= capacity.batch || signal?.aborted || !ctx.hasBudget()) return idle();

  // home(M3·mini)만 이 잡으로 확인한다. policy 에 없거나 probe 로 적힌 instance 는 claim 하지 않는다(반영·sweep 은 했다)
  const instanceId = serviceInstanceId();
  const control = await readUptimeSplitControl();
  const entry = instanceId && control.policy ? uptimeSplitHostEntry(control.policy, instanceId) : null;
  if (!instanceId || !entry || entry.class !== "home") {
    ctx.log("uptime.split_blocked", { unconfigured: 1 });
    return { done: false };
  }
  const owner = { instanceId, bootId: BOOT_ID };
  const batch = await claimUptimeProducts({ owner, limit: capacity.batch - swept });
  if (batch.kind === "blocked") {
    // 차단기 열림은 이 host 의 광역 장애다 — 확인을 쉬고 반영·sweep 만 한다. legacy 로 돌아갔으면 조용히 다음 틱으로
    if (batch.reason !== "mode_legacy") ctx.log("uptime.split_blocked", { breakerOpen: batch.reason === "breaker_open" ? 1 : 0,
      unconfigured: batch.reason === "source_unconfigured" ? 1 : 0, fenced: batch.reason === "site_fenced" ? 1 : 0 });
    return { done: false };
  }
  if (batch.claims.length === 0) return idle();

  let alive = 0;
  let down = 0;
  const results: UptimeOwnResult[] = [];
  const errors = await runOriginLanes(batch.claims, capacity.concurrency, () => !signal?.aborted && ctx.hasBudget(), async (ticket: UptimeClaimTicket) => {
    const check = await checkUptime(ticket.url);
    results.push({ productId: ticket.productId, token: ticket.token, epoch: ticket.epoch, startedAt: check.startedAt,
      observedAt: check.observedAt, kind: check.kind, status: check.status, latencyMs: check.latencyMs, textSample: check.textSample });
    if (check.up) alive++;
    else down++;
  });

  // 이미 본 결과라 예산이 끝났거나 앞에서 한 건이 실패했어도 반영한다(legacy 와 같다). 멈추라는 신호면 쓰지 않는다
  const settled = new Set<number>();
  if (results.length > 0 && !signal?.aborted) {
    try {
      const own = await applyUptimeResults({ lease, own: results, submittedLimit: 0, signal, hasBudget: ctx.hasBudget });
      for (const result of results) settled.add(result.productId);
      autoBanned += own.autoBanned;
      const held = own.reasons.split_broad_failure ?? 0;
      if (held > 0) ctx.log("uptime.broad_failure_held", { attempted: results.length, down: held });
    } catch (error) {
      errors.push(error);
    }
  }
  const unsettled = batch.claims.filter(ticket => !settled.has(ticket.productId));
  if (unsettled.length > 0) {
    try {
      await releaseUptimeClaims({ owner, claims: unsettled });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];

  ctx.log("uptime.checked", { alive, down, autoBanned });
  return { done: false };
}

/** 틱 끝까지 미룬 legacy 실패 — 세어 기록하거나(record) 확인 시각만 넘긴다(hold) */
type DeferredFailure = { record: () => Promise<void>; hold: () => Promise<void> };

/** 한 제품을 열어 보고 기록한다. 살았는지(up)·죽었는지(down)·봇·로그인 차단이라 알 수 없는지(unknown) */
async function ping(target: PingTarget, write: ReturnType<typeof oneAtATime>, ctx: JobContext<null>, onBanned: () => void, raw: { source: ReturnType<typeof uptimeObserverSource>; gateEnabled: boolean } | null, deferFailure: (failure: DeferredFailure) => void): Promise<"up" | "down" | "unknown"> {
  const check = await checkUptime(target.url);
  const unknown = !check.up && isUnknownUptimeStatus(check.status);
  const record = async () => {
    if (ctx.signal?.aborted) return;
    if (raw) {
      if (!ctx.lease) throw new Error("uptime_job_required");
      const result = await recordUptimeObservation({ observationId: randomUUID(), productId: target.id, slug: target.slug, url: target.url,
        slot: uptimeSlot(check.startedAt), startedAt: check.startedAt, observedAt: check.observedAt, source: raw.source,
        kind: check.kind, status: check.status, latencyMs: check.latencyMs }, { lease: ctx.lease, signal: ctx.signal });
      ctx.log("uptime.observation", { productId: target.id, host: raw.source.host, ...result });
      if (result.state !== "applied") return;
    } else {
      await recordPing(target.slug, check.status, check.latencyMs, check.observedAt, target.id, ctx.lease, target.url, ctx.signal);
    }
    if (!check.up && !unknown && await autoBanUptimeProduct(target, ctx)) onBanned();
    if (check.textSample) await refreshTextSample(target.slug, check.textSample, ctx.lease, target, ctx.signal).catch(() => {});
  };
  const hold = async () => {
    if (ctx.signal?.aborted) return;
    await recordPing(target.slug, check.status, null, check.observedAt, target.id, ctx.lease, target.url, ctx.signal, true);
  };
  // legacy 실패는 바로 쓰지 않는다 — 광역 실패 보류(pingProducts). 알 수 없는 응답은 세지 않으니 성공처럼 바로 쓴다.
  // raw 관측 모드는 관측 사실을 그대로 남긴다(광역 판정은 gate의 regional-v1 몫)
  if (!check.up && !unknown && !raw) deferFailure({ record, hold });
  else await write(record);
  return check.up ? "up" : unknown ? "unknown" : "down";
}

/** 넘긴 일을 들어온 순서대로 하나씩 실행한다. 앞의 일이 실패해도 다음 일은 돈다 */
function oneAtATime() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work);
    tail = run.catch(() => {});
    return run;
  };
}
