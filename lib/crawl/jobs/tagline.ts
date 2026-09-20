import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { getSettings } from "@/lib/crawl/settings";
import { TAGLINE_MODEL, taglineEvidence, taglineHash, writeTagline } from "@/lib/crawl/tagline";
import { pendingTaglines, recordTagline, recordTaglineFailure, releaseForPublish, touchTagline } from "@/lib/crawl/taglines";

/**
 * 소개 짓기 — 페이지에도 레포에도 소개가 없어 발행이 멈춘 후보의 한 줄을 모델이 짓는다.
 *
 * 발행 워커에서 돈다. 사유 번역과 같은 자리다 — 발행은 5분에 한 번이라 워커가 대부분 비어 있고,
 * 심사 워커에 두면 1차·2차 심사와 차례를 나눠 쓰느라 둘 다 느려진다.
 *
 * 지은 줄로 곧바로 발행하지 않는다. 후보를 "승인됨"으로 되돌려 놓기만 하고, 발행할지는 발행 잡이
 * 평소 관문(두 모델 승인·원본 리비전·분류)을 그대로 거쳐 정한다.
 */

/** 한 번에 집는 수. 한 건이 4초쯤이라 둘씩 돌리면 한 틱에 20여 건 */
const BATCH = 12;
const CONCURRENCY = 2;
/** 한 번 부르는 데 둘 시간 */
const CALL_MS = 45_000;
/** 틱 예산(worker.ts jobRunOptions 55초)보다 조금 짧게 */
const TICK_MS = 54_000;
/** 이만큼 남아 있을 때만 새로 부른다 — 틱 끝에 부르면 제한이 짧아져 헛실패가 난다 */
const MIN_CALL_MS = 15_000;

/** 게이트웨이가 막힌 것은 이 후보의 문제가 아니다 — 이번 틱을 접는다 */
const GATEWAY_DOWN = new Set(["no_key", "model_unavailable", "rate_limit", "timeout", "network"]);

export async function writeTaglines(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!process.env.ABCLLM_API_KEY?.trim()) {
    ctx.log("tagline.skipped", { reason: "no_key" });
    return { done: true };
  }
  const settings = await getSettings();
  if (!settings.enabled) {
    ctx.log("tagline.skipped", { reason: "disabled" });
    return { done: true };
  }

  const startedAt = Date.now();
  const remaining = () => TICK_MS - (Date.now() - startedAt);
  let written = 0, empty = 0, failed = 0, released = 0, blocked = "", inARow = 0;

  while (ctx.hasBudget() && remaining() >= MIN_CALL_MS) {
    const tasks = await pendingTaglines(BATCH);
    if (tasks.length === 0) {
      ctx.log("tagline.done", { written, empty, failed, released, drained: true });
      return { done: true };
    }

    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (let index = next++; index < tasks.length; index = next++) {
        if (blocked || !ctx.hasBudget() || remaining() < MIN_CALL_MS) return;
        const { candidate, document, written: stored } = tasks[index];
        const evidence = taglineEvidence(candidate.repo, document);
        const sourceHash = taglineHash(evidence);

        /**
         * 다시 긁혔지만 내용은 그대로다 — 본 판만 새로 적고 넘어간다.
         *
         * 실패한 줄은 여기서 넘기면 안 된다. 실패도 그때 본 원본의 해시를 남기므로, 해시만 보고
         * 건너뛰면 다시 볼 시각이 지나도 영영 다시 묻지 않는다 — 프로드에서 게이트웨이 502 를 만난
         * 7건이 90분 동안 시도 1회에 멈춘 채 대기열을 차지했다(2026-09-20).
         */
        if (stored && stored.sourceHash === sourceHash && !stored.errorCode) {
          await touchTagline(candidate.repo, document.fetchedAt);
          if (stored.tagline && await releaseForPublish(candidate.id)) released++;
          continue;
        }
        // 읽을 글이 아무 데도 없다. 모델을 불러도 지을 수 없으므로 사람에게 남긴다
        if (!evidence.pageText && !evidence.readme && !evidence.pageTitle) {
          await recordTagline({ repo: candidate.repo, tagline: "", source: "page", model: "", sourceHash, documentAt: document.fetchedAt });
          empty++;
          continue;
        }

        const ask = () => writeTagline(evidence, { timeoutMs: Math.max(1_000, Math.min(CALL_MS, remaining() - 1_000)) });
        let result = await ask();
        /**
         * 빈 줄("증거로는 무엇인지 알 수 없다")은 흔들리는 답이다 — 같은 증거로 다시 물으면 멀쩡한
         * 줄이 오는 때가 14건 중 3~4건이었다(2026-09-20 프로드 실측, 온도 0인데도 그렇다).
         * 한 번만 더 묻는다. 두 번 다 빈 줄이면 그 후보는 사람이 본다.
         */
        if (result.ok && !result.tagline && remaining() >= MIN_CALL_MS) result = await ask();
        if (!result.ok) {
          await recordTaglineFailure({ repo: candidate.repo, sourceHash, documentAt: document.fetchedAt, error: result.error });
          failed++;
          /**
           * 한 건의 실패로 틱을 접지 않는다 — 같은 증거에만 502 를 돌려주는 후보가 있어
           * (긴 페이지 글) 그 한 건이 나머지의 차례까지 막았다. 잇따라 둘이 실패하면 그때 접는다.
           */
          if (GATEWAY_DOWN.has(result.error) || result.error.startsWith("http_5")) {
            if (++inARow >= 2) blocked = result.error;
          }
          continue;
        }
        inARow = 0;
        await recordTagline({ repo: candidate.repo, tagline: result.tagline, source: result.source, model: TAGLINE_MODEL, sourceHash, documentAt: document.fetchedAt });
        if (!result.tagline) { empty++; continue; }
        written++;
        if (await releaseForPublish(candidate.id)) released++;
      }
    }));
    if (blocked) {
      ctx.log("tagline.gateway_blocked", { error: blocked, written, empty, failed, released });
      return { done: true };
    }
  }

  ctx.log("tagline.done", { written, empty, failed, released, drained: false });
  return { done: false };
}
