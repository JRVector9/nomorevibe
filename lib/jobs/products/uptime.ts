import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { safeFetch, readBodyCapped, fetchPage } from "@/lib/net/fetch";
import { extractTextSample, metaRefreshTarget } from "@/lib/net/normalize";
import { refreshTextSample } from "@/lib/crawl/repository";
import { nextToCheck, recordPing } from "@/lib/domain/products/health";

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
 * 한 바퀴는 빠르지 않다. 10분마다 15건이면 시간당 90건이라 3천 건에 이틀 가까이 걸린다.
 * 배치를 키우면 당길 수 있지만 남의 서버를 그만큼 더 두드리는 일이라 여기서는 두지 않는다.
 *
 * 커서가 없다. 확인한 지 오래된 것부터 가져오므로 확인 시각 자체가 진행 지점이다.
 */

/** 한 틱에 확인하는 수. 하나에 최대 10초(safeFetch 타임아웃)라 예산 안에서 이만큼이면 충분하다 */
const BATCH = 15;

/**
 * 본문에서 받아 볼 바이트 상한.
 *
 * 판정에 쓰는 것은 앞부분 1,500자뿐이다. 수집 때 쓰는 2MB를 그대로 쓰면 10분마다
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

  for (const target of targets) {
    if (!ctx.hasBudget()) break;

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

    await recordPing(target.slug, status, fetched ? latencyMs : null, new Date(), target.id);
    if (sample) await refreshTextSample(target.slug, sample).catch(() => {});

    if (up) alive++;
    else down++;
  }

  ctx.log("uptime.checked", { alive, down });
  // 한 바퀴를 다 돌았는지는 여기서 알 수 없다 — 오래된 것부터 계속 가져오면 그만이다
  return { done: false };
}
