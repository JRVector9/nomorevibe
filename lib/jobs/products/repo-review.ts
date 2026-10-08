import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { fetchPage, readBodyCapped, safeFetch } from "@/lib/net/fetch";
import { extractPageMeta, extractTextSample, metaRefreshTarget } from "@/lib/net/normalize";
import { askRepoReview, decideFromAnswers, preFilter, REPO_REVIEW_MODEL, type RepoReviewPage } from "@/lib/domain/products/repo-review";
import { dueRepoReviews, saveRepoReview, type RepoReviewTarget } from "@/lib/domain/products/repo-reviews";

/**
 * 저장소가 사라졌거나 빈 웹사이트 제품을 다시 본다 — 사이트가 아직 그 제품인가(repo-review.ts).
 *
 * text 워커에서 돈다 — 게이트웨이 키(ABCLLM_API_KEY)가 있는 역할이고, 키워드 검수와 같은 Qwen3.8 을 쓴다.
 * 5분마다 8건까지, 셋씩 동시에. 한 건은 페이지 열기(10초 상한) + 모델 한 번(시험 중앙값 0.8초)이다.
 * 저장소가 사라진 웹사이트는 2026-10-08 공개 3만7천 개 중 4% 남짓(약 1,400개)으로 보여 처음 채우는 데 하루쯤,
 * 그 뒤로는 새로 사라진 것과 다시 볼 때가 된 것만 본다.
 *
 * 답이 깨지면 한 번 더 묻고, 또 깨지면 사람에게 넘긴다(human · invalid_output). 게이트웨이가 막힌 것(키 없음·시간 초과·
 * 연결·5xx)은 제품의 문제가 아니라 적지 않는다 — 잇따라 둘이 막히면 이번 틱을 접는다.
 * 아무것도 가리지 않는다. 판정만 적고, 운영자가 어드민 '저장소 사라짐'에서 유지·내리기를 고른다.
 */
const BATCH = 8;
const CONCURRENCY = 3;
/** 틱 예산(worker.ts jobRunOptions 55초)보다 조금 짧게 */
const TICK_MS = 50_000;
/** 페이지 열기(10초)와 모델 한 번을 끝낼 시간이 남았을 때만 새 건을 시작한다 */
const MIN_START_MS = 25_000;
const CALL_MS = 15_000;
const PAGE_BYTES = 256 * 1024;
const EXCERPT_CHARS = 500;
const GATEWAY_DOWN = new Set(["no_key", "model_unavailable", "rate_limit", "timeout", "network"]);

/** 생존 확인(uptime.ts)과 같은 규칙으로 연다 — 같은 SSRF 가드, meta refresh 한 번 따라가기, 256KB 까지 */
export async function openProductPage(url: string): Promise<RepoReviewPage> {
  const fetched = await safeFetch(url, "background");
  if (!fetched) return { status: 0, finalUrl: null, title: "", text: "" };
  const status = fetched.response.status;
  try {
    let html = (await readBodyCapped(fetched.response, PAGE_BYTES)).toString("utf-8");
    let finalUrl = fetched.finalUrl;
    const hop = status >= 200 && status < 400 ? metaRefreshTarget(html, finalUrl) : null;
    if (hop) {
      const next = await fetchPage(hop, "background");
      if (next) { html = next.html; finalUrl = next.finalUrl; }
    }
    return { status, finalUrl, title: extractPageMeta(html, finalUrl).title ?? "", text: extractTextSample(html) ?? "" };
  } catch {
    // 본문을 못 읽어도 응답 코드는 안다 — 글이 없는 페이지로 본다(거르기가 사람에게 넘긴다)
    return { status, finalUrl: fetched.finalUrl, title: "", text: "" };
  }
}

type Dependencies = { openPage?: (url: string) => Promise<RepoReviewPage>; request?: typeof fetch };

export async function reviewGoneRepositories(ctx: JobContext<null>, dependencies: Dependencies = {}): Promise<JobOutcome<null>> {
  if (!process.env.ABCLLM_API_KEY?.trim()) {
    ctx.log("repo_review.skipped", { reason: "no_key" });
    return { done: true };
  }
  const startedAt = Date.now();
  const remaining = () => TICK_MS - (Date.now() - startedAt);
  const targets = await dueRepoReviews(BATCH);
  if (targets.length === 0) {
    ctx.log("repo_review.idle", { reviewed: 0 });
    return { done: true };
  }
  const openPage = dependencies.openPage ?? openProductPage;
  const counts = { keep: 0, delist_candidate: 0, human: 0, prefiltered: 0, invalid: 0, gatewayFailed: 0 };
  let blocked = "", inARow = 0, next = 0;
  // 쓰기는 한 번에 하나 — text 워커의 DB 풀(3)에 러너 임대 갱신 몫을 남긴다(uptime.ts 와 같은 까닭)
  let writing: Promise<unknown> = Promise.resolve();
  const oneAtATime = (write: () => Promise<void>) => {
    const run = writing.then(write);
    writing = run.catch(() => {});
    return run;
  };

  const review = async (target: RepoReviewTarget) => {
    const page = await openPage(target.url);
    const save = (decision: "keep" | "delist_candidate" | "human", reason: string, answers: Parameters<typeof decideFromAnswers>[0] | null) =>
      oneAtATime(() => saveRepoReview({ productId: target.id, decision, reason, answers, model: answers || reason === "invalid_output" ? REPO_REVIEW_MODEL : null,
        pageHttpStatus: page.status, finalUrl: page.finalUrl, pageTitle: page.title || null,
        pageExcerpt: page.text ? page.text.slice(0, EXCERPT_CHARS) : null }, ctx.lease)).then(() => { counts[decision]++; });
    const filtered = preFilter(target, page, { downSince: target.downSince });
    if (filtered) { counts.prefiltered++; return save(filtered.decision, filtered.reason, null); }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (blocked || ctx.signal?.aborted) return;
      const asked = await askRepoReview(target, page, { timeoutMs: Math.max(1_000, Math.min(CALL_MS, remaining())),
        request: dependencies.request, signal: ctx.signal });
      if (asked.ok) { inARow = 0; return save(decideFromAnswers(asked.answers), "model", asked.answers); }
      if (asked.error === "invalid_output") { counts.invalid++; continue; }
      // 게이트웨이가 막혔다 — 이 제품은 적지 않고 다음 틱에 다시 본다
      counts.gatewayFailed++;
      if (asked.error === "cancelled") return;
      if ((GATEWAY_DOWN.has(asked.error) || asked.error.startsWith("http_5")) && ++inARow >= 2) blocked = asked.error;
      return;
    }
    return save("human", "invalid_output", null);
  };

  const settled = await Promise.allSettled(Array.from({ length: CONCURRENCY }, async () => {
    for (let index = next++; index < targets.length; index = next++) {
      if (blocked || ctx.signal?.aborted || !ctx.hasBudget() || remaining() < MIN_START_MS) return;
      await review(targets[index]);
    }
  }));
  const failure = settled.find((item) => item.status === "rejected");
  if (failure) throw failure.reason;
  if (blocked) {
    ctx.log("repo_review.blocked", { error: blocked, ...counts });
    return { done: true };
  }
  ctx.log("repo_review.reviewed", counts);
  return { done: targets.length < BATCH };
}
