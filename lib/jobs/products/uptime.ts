import { randomUUID } from "node:crypto";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { safeFetch, readBodyCapped, fetchPage } from "@/lib/net/fetch";
import { extractTextSample, metaRefreshTarget } from "@/lib/net/normalize";
import { refreshTextSample } from "@/lib/crawl/repository";
import { nextToCheck, recordPing, type PingTarget } from "@/lib/domain/products/health";
import { isUnknownUptimeStatus } from "@/lib/domain/products/health-record";
import { uptimeSlot } from "@/lib/domain/products/uptime-policy";
import { uptimeObservationMode, uptimeObserverSource, nextUptimeObservationTargets, recordUptimeObservation } from "@/lib/domain/products/uptime-observations";
import { autoBanUptimeProduct, nextUptimeAutoBanTargets } from "@/lib/domain/products/uptime-auto-ban";

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
 * 광역 실패 보류 기준. 평소 하루 실패는 확인의 0.6~1.8%다(2026-10-14~18) — 한 틱의 30%를 넘는 실패는
 * 사이트가 아니라 이 서버 쪽 문제로 본다. 표본이 너무 작으면 몇 건만 죽어도 비율이 튀므로 30건부터 판단한다.
 */
const BROAD_FAILURE_MIN_ATTEMPTS = 30;
const BROAD_FAILURE_RATE = 0.3;

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

/**
 * 본문에서 받아 볼 바이트 상한.
 *
 * 판정에 쓰는 것은 앞부분 1,500자뿐이다. 수집 때 쓰는 2MB를 그대로 쓰면 1분마다
 * 여러 건에서 쓰지도 않을 바이트를 받는다. 256KB면 첫 화면 글자를 담기에 충분하다.
 */
const BODY_BYTES = 256 * 1024;

export async function pingProducts(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const capacity = uptimeCapacityConfig();
  const observationMode = await uptimeObservationMode();
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
  const errors: unknown[] = [];
  /** legacy 실패 기록 — 틱 끝에 광역 실패인지 본 뒤 센다(record) 또는 판정을 보류한다(hold) */
  const failures: DeferredFailure[] = [];
  const lanes = byOrigin(targets);

  /**
   * 한 건이 실패하면 새로 열지 않는다. 다만 이미 연 것은 끝까지 읽거나 끊고 기록한 뒤에
   * 실패를 알린다 — 먼저 던지면 남은 확인이 러너가 임대를 푼 뒤에 뒤늦게 기록된다.
   */
  await Promise.all(Array.from({ length: Math.min(capacity.concurrency, lanes.length) }, async () => {
    for (let lane = lanes.shift(); lane; lane = lanes.shift()) {
      for (const target of lane) {
        if (errors.length > 0 || ctx.signal?.aborted || !ctx.hasBudget()) return;
        try {
          const result = await ping(target, write, ctx, () => { autoBanned++; }, raw, failure => { failures.push(failure); });
          if (result === "up") alive++;
          else if (result === "unknown") unknown++;
          else down++;
        } catch (error) {
          errors.push(error);
          return;
        }
      }
    }
  }));

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

/** 틱 끝까지 미룬 legacy 실패 — 세어 기록하거나(record) 확인 시각만 넘긴다(hold) */
type DeferredFailure = { record: () => Promise<void>; hold: () => Promise<void> };

/** 한 제품을 열어 보고 기록한다. 살았는지(up)·죽었는지(down)·봇·로그인 차단이라 알 수 없는지(unknown) */
async function ping(target: PingTarget, write: ReturnType<typeof oneAtATime>, ctx: JobContext<null>, onBanned: () => void, raw: { source: ReturnType<typeof uptimeObserverSource>; gateEnabled: boolean } | null, deferFailure: (failure: DeferredFailure) => void): Promise<"up" | "down" | "unknown"> {
  // GET이라 본문 스트림이 열린 채로 온다. 안 읽고 취소하지 않으면 연결이 풀로 돌아가지
  // 않고 버퍼가 남는다 — 어느 쪽이든 스트림을 반드시 닫는다.
  const observationStartedAt = new Date();
  const startedAt = performance.now();
  const fetched = await safeFetch(target.url, "background");
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  const status = fetched?.response.status ?? 0;
  const up = status >= 200 && status < 400;
  const unknown = !up && isUnknownUptimeStatus(status);

  let sample: string | null = null;
  if (fetched && up) {
    // readBodyCapped은 상한에 닿으면 스스로 스트림을 끊는다
    try {
      const html = (await readBodyCapped(fetched.response, BODY_BYTES)).toString("utf-8");
      /**
       * 수집 잡과 같은 규칙으로 본다. 여기만 meta refresh를 안 따라가면 껍데기의
       * "Redirecting…"이 수집이 확보한 목적지 본문을 덮어써, 재검수의 근거가 사라진다.
       */
      const hop = metaRefreshTarget(html, fetched.finalUrl);
      sample = extractTextSample(hop ? (await fetchPage(hop, "background"))?.html ?? html : html);
    } catch {
      sample = null; // 본문은 부가물이다 — 못 읽어도 생존 확인은 그대로 기록한다
    }
  } else {
    await fetched?.response.body?.cancel().catch(() => {});
  }

  const observedAt = new Date();
  const record = async () => {
    if (ctx.signal?.aborted) return;
    if (raw) {
      if (!ctx.lease) throw new Error("uptime_job_required");
      const result = await recordUptimeObservation({ observationId: randomUUID(), productId: target.id, slug: target.slug, url: target.url,
        slot: uptimeSlot(observationStartedAt), startedAt: observationStartedAt, observedAt, source: raw.source,
        kind: fetched ? "http" : "unknown", status, latencyMs: fetched ? latencyMs : null }, { lease: ctx.lease, signal: ctx.signal });
      ctx.log("uptime.observation", { productId: target.id, host: raw.source.host, ...result });
      if (result.state !== "applied") return;
    } else {
      await recordPing(target.slug, status, fetched ? latencyMs : null, observedAt, target.id, ctx.lease, target.url, ctx.signal);
    }
    if (!up && !unknown && await autoBanUptimeProduct(target, ctx)) onBanned();
    if (sample) await refreshTextSample(target.slug, sample, ctx.lease, target, ctx.signal).catch(() => {});
  };
  const hold = async () => {
    if (ctx.signal?.aborted) return;
    await recordPing(target.slug, status, null, observedAt, target.id, ctx.lease, target.url, ctx.signal, true);
  };
  // legacy 실패는 바로 쓰지 않는다 — 광역 실패 보류(pingProducts). 알 수 없는 응답은 세지 않으니 성공처럼 바로 쓴다.
  // raw 관측 모드는 관측 사실을 그대로 남긴다(광역 판정은 gate의 regional-v1 몫)
  if (!up && !unknown && !raw) deferFailure({ record, hold });
  else await write(record);
  return up ? "up" : unknown ? "unknown" : "down";
}

/**
 * 같은 서버의 주소를 한 줄로 묶는다. 한 줄은 한 번에 한 곳에서만 차례로 연다.
 * 오래된 순서는 줄 안에서도 줄 사이에서도 그대로다. 주소가 깨졌으면 그 자체를 한 줄로 둔다 —
 * 여기서 던지면 그 제품이 계속 가장 오래된 채로 남아 매 틱을 막는다(열기는 safeFetch가 거른다).
 */
function byOrigin(targets: PingTarget[]): PingTarget[][] {
  const lanes = new Map<string, PingTarget[]>();
  for (const target of targets) {
    const origin = URL.parse(target.url)?.origin ?? target.url;
    const lane = lanes.get(origin);
    if (lane) lane.push(target);
    else lanes.set(origin, [target]);
  }
  return [...lanes.values()];
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
