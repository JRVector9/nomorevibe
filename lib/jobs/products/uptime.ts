import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { safeFetch } from "@/lib/net/fetch";
import { nextToCheck, recordPing } from "@/lib/domain/products/health";

/**
 * 생존 확인 잡.
 *
 * 등재된 제품이 아직 떠 있는지 본다. 죽은 링크가 목록에 남아 있으면 "직접 확인한 것만
 * 보여준다"는 말이 무의미해진다.
 *
 * 결과를 기록만 하고 목록을 건드리지 않는다 — 배포가 잠깐 흔들린 것과 서비스가 끝난 것을
 * 응답 코드만으로 가를 수 없다. 어드민이 보고 차단한다.
 *
 * 커서가 없다. 확인한 지 오래된 것부터 가져오므로 확인 시각 자체가 진행 지점이다.
 */

/** 한 틱에 확인하는 수. 하나에 최대 10초(safeFetch 타임아웃)라 예산 안에서 이만큼이면 충분하다 */
const BATCH = 15;

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

    // 본문은 읽지 않는다. 살아 있는지만 보는데 매번 페이지를 통째로 받을 이유가 없다.
    // 다만 GET이라 본문 스트림이 열린 채로 온다 — 취소하지 않으면 연결이 풀로 돌아가지
    // 않고 버퍼가 남는다. 10분마다 15건이면 조용히 쌓인다.
    const fetched = await safeFetch(target.url);
    const status = fetched?.response.status ?? 0;
    await fetched?.response.body?.cancel().catch(() => {});
    await recordPing(target.slug, status);

    if (status >= 200 && status < 400) alive++;
    else down++;
  }

  ctx.log("uptime.checked", { alive, down });
  // 한 바퀴를 다 돌았는지는 여기서 알 수 없다 — 오래된 것부터 계속 가져오면 그만이다
  return { done: false };
}
