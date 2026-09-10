import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { safeFetch, readBodyCapped, fetchPage } from "@/lib/net/fetch";
import { extractTextSample, metaRefreshTarget } from "@/lib/net/normalize";
import { refreshTextSample } from "@/lib/crawl/repository";
import { nextToCheck, recordPing, type PingTarget } from "@/lib/domain/products/health";

/**
 * 생존 확인 잡.
 *
 * 등재된 제품이 아직 떠 있는지 본다. 죽은 링크가 목록에 남아 있으면 "직접 확인한 것만
 * 보여준다"는 말이 무의미해진다.
 *
 * 결과를 기록만 하고 목록을 건드리지 않는다 — 배포가 잠깐 흔들린 것과 서비스가 끝난 것을
 * 응답 코드만으로 가를 수 없다. 차단은 어드민이 정한다.
 *
 * 여는 김에 본문 앞부분도 담아 둔다. 판정 규칙이 본문을 보게 됐는데(설치 유도 아님)
 * 이미 발행된 것들은 그 값이 없던 시절에 수집됐다. 같은 주소를 어차피 여기서 여니
 * 새 요청 없이 채워진다 — 그래야 발행분 재검수가 지금 기준으로 다시 태운다.
 *
 * 한 바퀴가 재확인 간격(6시간)을 따라가야 한다. 발행분 3,147건을 6시간마다 보려면 시간당
 * 525건이 든다. 10분마다 15건(시간당 90건)일 때는 6시간 안에 17%만 볼 수 있었고 한 바퀴에
 * 35시간이 걸렸다. 1분마다 15건이면 시간당 900건 — 전부 밀려 있어도 한 바퀴 3.5시간이다.
 *
 * 주기를 당긴 만큼 한 틱이 늘어지면 안 된다. 순차로 열면 응답 없는 서버 하나가 10초를 먹어
 * 25초 예산에 두세 건밖에 못 본다. 그래서 서로 다른 서버를 CONCURRENCY곳까지 동시에 연다.
 * 전부 10초 타임아웃이어도 0·10·20초에 세 건씩 한 틱 9건, 시간당 540건이라 6시간은 지킨다.
 *
 * 남의 서버를 두드리지 않는다는 원칙은 동시에 열어도 그대로다. 같은 서버(origin)는 한 번에
 * 하나씩만 열고, 제품마다 6시간에 한 번이라는 제한(nextToCheck)도 그대로라 한 서버가 받는
 * 요청은 늘지 않는다 — 밀린 몫을 빨리 따라잡을 뿐이다. 배치도 키우지 않는다.
 *
 * 커서가 없다. 확인한 지 오래된 것부터 가져오므로 확인 시각 자체가 진행 지점이다.
 */

/**
 * 한 틱에 확인하는 수의 상한. 예산(25초)이 먼저 끝나면 거기서 멈추고, 남은 것은 가장
 * 오래된 채로 남아 다음 틱이 먼저 가져간다.
 */
const BATCH = 15;

/**
 * 한 틱 안에서 동시에 여는 서버 수.
 *
 * HTTP만 동시에 연다. 기록(DB 쓰기)은 한 번에 하나씩 줄을 세운다 — 기록은 밀리초라 느려지지
 * 않고, 그래야 이 잡이 동시에 쥐는 DB 연결이 기록 1 + 러너 임대 갱신 1 = 2로 묶여
 * maintenance 풀(3) 안에 든다. 기록까지 동시에 하면 3 + 1 = 4로 풀을 넘는다.
 */
const CONCURRENCY = 3;

/**
 * 본문에서 받아 볼 바이트 상한.
 *
 * 판정에 쓰는 것은 앞부분 1,500자뿐이다. 수집 때 쓰는 2MB를 그대로 쓰면 1분마다
 * 15건씩 쓰지도 않을 바이트를 받는다. 256KB면 어떤 페이지든 첫 화면 글자는 다 들어온다.
 */
const BODY_BYTES = 256 * 1024;

export async function pingProducts(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const targets = await nextToCheck(BATCH);
  if (targets.length === 0) {
    ctx.log("uptime.idle", { checked: 0 });
    return { done: true };
  }

  let alive = 0;
  let down = 0;
  const errors: unknown[] = [];
  const lanes = byOrigin(targets);
  const write = oneAtATime();

  /**
   * 한 건이 실패하면 새로 열지 않는다. 다만 이미 연 것은 끝까지 읽거나 끊고 기록한 뒤에
   * 실패를 알린다 — 먼저 던지면 남은 확인이 러너가 임대를 푼 뒤에 뒤늦게 기록된다.
   */
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, lanes.length) }, async () => {
    for (let lane = lanes.shift(); lane; lane = lanes.shift()) {
      for (const target of lane) {
        if (errors.length > 0 || !ctx.hasBudget()) return;
        try {
          if (await ping(target, write)) alive++;
          else down++;
        } catch (error) {
          errors.push(error);
          return;
        }
      }
    }
  }));
  if (errors.length > 0) throw errors[0];

  ctx.log("uptime.checked", { alive, down });
  // 한 바퀴를 다 돌았는지는 여기서 알 수 없다 — 오래된 것부터 계속 가져오면 그만이다
  return { done: false };
}

/** 한 제품을 열어 보고 기록한다. 살아 있으면 true */
async function ping(target: PingTarget, write: ReturnType<typeof oneAtATime>): Promise<boolean> {
  // GET이라 본문 스트림이 열린 채로 온다. 안 읽고 취소하지 않으면 연결이 풀로 돌아가지
  // 않고 버퍼가 남는다 — 어느 쪽이든 스트림을 반드시 닫는다.
  const startedAt = performance.now();
  const fetched = await safeFetch(target.url);
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  const status = fetched?.response.status ?? 0;
  const up = status >= 200 && status < 400;

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
      sample = extractTextSample(hop ? (await fetchPage(hop))?.html ?? html : html);
    } catch {
      sample = null; // 본문은 부가물이다 — 못 읽어도 생존 확인은 그대로 기록한다
    }
  } else {
    await fetched?.response.body?.cancel().catch(() => {});
  }

  const observedAt = new Date();
  await write(async () => {
    await recordPing(target.slug, status, fetched ? latencyMs : null, observedAt, target.id);
    if (sample) await refreshTextSample(target.slug, sample).catch(() => {});
  });
  return up;
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
