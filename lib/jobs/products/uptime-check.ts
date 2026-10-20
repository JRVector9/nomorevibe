import { safeFetch, readBodyCapped, fetchPage } from "@/lib/net/fetch";
import { extractTextSample, metaRefreshTarget } from "@/lib/net/normalize";

/**
 * 생존 확인 한 건의 공통부 — legacy(recordPing)와 split claims(묶음 적용기) 경로가 같은 HTTP·본문 처리·서버(origin) 직렬을 쓴다.
 * DB 를 읽거나 쓰지 않는다. 기록은 부르는 쪽 몫이다.
 */

/**
 * 본문에서 받아 볼 바이트 상한.
 *
 * 판정에 쓰는 것은 앞부분 1,500자뿐이다. 수집 때 쓰는 2MB를 그대로 쓰면 1분마다
 * 여러 건에서 쓰지도 않을 바이트를 받는다. 256KB면 첫 화면 글자를 담기에 충분하다.
 */
const BODY_BYTES = 256 * 1024;

/** 한 번 열어 본 결과. 시각은 이 서버의 시계다. 연결 실패는 status 0·kind unknown·지연 없음이다 */
export type UptimeCheck = {
  up: boolean; status: number; kind: "http" | "unknown"; latencyMs: number | null;
  startedAt: Date; observedAt: Date; textSample: string | null;
};

/** 한 주소를 열어 본다. 살아 있으면(2xx·3xx) 본문 앞부분을 텍스트 표본으로 담는다 */
export async function checkUptime(url: string): Promise<UptimeCheck> {
  // GET이라 본문 스트림이 열린 채로 온다. 안 읽고 취소하지 않으면 연결이 풀로 돌아가지
  // 않고 버퍼가 남는다 — 어느 쪽이든 스트림을 반드시 닫는다.
  const startedAt = new Date();
  const started = performance.now();
  const fetched = await safeFetch(url, "background");
  const latencyMs = Math.max(0, Math.round(performance.now() - started));
  const status = fetched?.response.status ?? 0;
  const up = status >= 200 && status < 400;

  let textSample: string | null = null;
  if (fetched && up) {
    // readBodyCapped은 상한에 닿으면 스스로 스트림을 끊는다
    try {
      const html = (await readBodyCapped(fetched.response, BODY_BYTES)).toString("utf-8");
      /**
       * 수집 잡과 같은 규칙으로 본다. 여기만 meta refresh를 안 따라가면 껍데기의
       * "Redirecting…"이 수집이 확보한 목적지 본문을 덮어써, 재검수의 근거가 사라진다.
       */
      const hop = metaRefreshTarget(html, fetched.finalUrl);
      textSample = extractTextSample(hop ? (await fetchPage(hop, "background"))?.html ?? html : html);
    } catch {
      textSample = null; // 본문은 부가물이다 — 못 읽어도 생존 확인은 그대로 기록한다
    }
  } else {
    await fetched?.response.body?.cancel().catch(() => {});
  }
  return { up, status, kind: fetched ? "http" : "unknown", latencyMs: fetched ? latencyMs : null, startedAt, observedAt: new Date(), textSample };
}

/**
 * 같은 서버의 주소를 한 줄로 묶는다. 한 줄은 한 번에 한 곳에서만 차례로 연다.
 * 오래된 순서는 줄 안에서도 줄 사이에서도 그대로다. 주소가 깨졌으면 그 자체를 한 줄로 둔다 —
 * 여기서 던지면 그 제품이 계속 가장 오래된 채로 남아 매 틱을 막는다(열기는 safeFetch가 거른다).
 */
export function byOrigin<T extends { url: string }>(targets: readonly T[]): T[][] {
  const lanes = new Map<string, T[]>();
  for (const target of targets) {
    const origin = URL.parse(target.url)?.origin ?? target.url;
    const lane = lanes.get(origin);
    if (lane) lane.push(target);
    else lanes.set(origin, [target]);
  }
  return [...lanes.values()];
}

/**
 * 서로 다른 서버를 concurrency 곳까지 동시에 열고, 같은 서버 줄은 차례로 연다. canContinue 가 거짓이면 새로 열지 않는다.
 * 한 건이 실패하면 새로 열지 않는다. 다만 이미 연 것은 끝까지 읽거나 끊고 기록한 뒤에 실패를 알린다 —
 * 먼저 던지면 남은 확인이 러너가 임대를 푼 뒤에 뒤늦게 기록된다. 돌려준 오류 목록의 첫 것이 원인이다.
 */
export async function runOriginLanes<T extends { url: string }>(targets: readonly T[], concurrency: number,
  canContinue: () => boolean, work: (target: T) => Promise<void>): Promise<unknown[]> {
  const lanes = byOrigin(targets), errors: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, lanes.length) }, async () => {
    for (let lane = lanes.shift(); lane; lane = lanes.shift()) {
      for (const target of lane) {
        if (errors.length > 0 || !canContinue()) return;
        try {
          await work(target);
        } catch (error) {
          errors.push(error);
          return;
        }
      }
    }
  }));
  return errors;
}
