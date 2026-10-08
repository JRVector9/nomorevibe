import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import type { FrontierEntry } from "@/lib/db/schema";
import { fetchPage } from "@/lib/net/fetch";
import { normalizeUrl, extractPageMeta, metaRefreshTarget } from "@/lib/net/normalize";
import { siteHints } from "@/lib/domain/products/thumbnails/candidates";
import { resolveCanonical } from "@/lib/domain/products/register";
import * as crawl from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import { getRepo } from "@/lib/crawl/github";
import { PROBE_COMMITS, probeAiEvidence } from "@/lib/crawl/ai-evidence-gate";
import { probePackageManifests } from "@/lib/crawl/package-probe";
import { PACKAGE_PROOF_KEY } from "@/lib/crawl/package-proof";
import { INSTALLABLE_MIN_STARS, PACKAGE_MIN_STARS, lacksDeployment } from "@/lib/domain/products/access";
import { SHOW_HN_SIGNAL } from "@/lib/crawl/settings-schema";
import { extractSiteRepositoryKeys } from "@/lib/domain/evidence/providers/site-fingerprint";
import { extractGithubLinks } from "@/lib/crawl/github-links";
import { requeueAfterAdminEvidenceRefresh } from "@/lib/crawl/admin-review";
import { requestJob } from "@/lib/jobs/control";
import { assertJobLease } from "@/lib/jobs/control";
import { db } from "@/lib/db";

/**
 * 수집 잡 — 프론티어에서 꺼낸 레포의 원본을 확보한다.
 *
 * 레포 메타는 가공하지 않고 그대로 보관한다. 판정은 다음 잡이 하고, 기준이 바뀌면 이
 * 원본으로 다시 판정한다 — GitHub을 다시 긁지 않기 위해 둘을 나눠 둔 것이다.
 *
 * 셋까지 함께 돈다. 한 항목은 GitHub 한 번과 배포 페이지 한두 번이고 시간 대부분이 HTTP
 * 대기라, 순차로 돌면 한 틱 내내 거의 기다리기만 했다. 순차로 돌던 이유는 실패한 항목이
 * 무엇이고 왜 실패했는지를 잃지 않으려는 것이었는데, 그것은 동시성의 전제이기도 하다 —
 * 실패는 항목별로 남기고, 한 항목의 예외가 묶음의 나머지 claim을 붙잡지 않게 한다.
 */

/** 한 번에 꺼내는 프론티어 항목 수. 예산이 남으면 다음 묶음을 또 꺼낸다 */
const BATCH = 10;

/**
 * 동시에 처리하는 항목 수.
 *
 * crawler 역할의 DB 풀은 4연결이다(lib/db/pool.ts). 러너의 리스 갱신이 하나를 쓰고, 항목은
 * HTTP 동안 DB를 잡지 않고 짧은 조회·저장 트랜잭션 때만 하나씩 쓰므로 셋이면 풀을 기다리지 않는다.
 */
const CONCURRENCY = 3;

/**
 * GitHub API의 origin. "같은 origin에는 한 번에 하나"를 GitHub에도 건다 — GitHub은 2차 한도를
 * 피하려면 한 토큰의 요청을 동시가 아니라 차례로 보내라고 안내하고, core 쿼터는 모든 수집 잡이
 * 나눠 쓴다(github-quota.ts). 페이지 대기가 길어서 GitHub을 차례로 보내도 셋이 함께 도는 효과는 남는다.
 */
const GITHUB_ORIGIN = "https://api.github.com";

/** gated: AI 흔적이 없어 들여보내지 않은 것(requireEvidence 신호) */
type Tally = { fetched: number; skipped: number; failed: number; gated: number };

export async function fetchCrawlDocuments(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  if (!settings.enabled) {
    ctx.log("crawl.fetch_skipped", { reason: "disabled" });
    return { done: true };
  }
  /** 흔적이 있어야 들여보내는 신호(settings-schema requireEvidence) — 프론티어의 signal 이 그 라벨이다 */
  const evidenceRequired = new Set(settings.discover.queries.filter((q) => q.requireEvidence).map((q) => q.label));
  if (settings.discover.showHn.requireEvidence) evidenceRequired.add(SHOW_HN_SIGNAL);
  if (ctx.lease && ctx.hasBudget()) {
    const recovered = await crawl.recoverAbandonedFrontier(ctx.lease);
    if (recovered) ctx.log("crawl.fetch_recovered", { recovered });
    const handedOff = await crawl.handOffFailedSourceRefreshes(ctx.lease);
    if (handedOff) ctx.log("crawl.fetch_source_refresh_handed_off", { count: handedOff });
  }

  const tally: Tally = { fetched: 0, skipped: 0, failed: 0, gated: 0 };
  const oneAtATime = originQueue();

  while (ctx.hasBudget()) {
    const entries = ctx.lease ? await crawl.dequeue(BATCH, undefined, ctx.lease) : await crawl.dequeue(BATCH);
    if (entries.length === 0) {
      ctx.log("crawl.fetched", { ...tally, drained: true });
      return { done: true };
    }

    const { retryAt, pauseReason } = await fetchBatch(entries, ctx, settings.judge.docsGenerators, evidenceRequired, oneAtATime, tally);
    if (retryAt) {
      ctx.log(pauseReason === "auth_unavailable" ? "crawl.fetch_auth_unavailable" : "crawl.fetch_rate_limited",
        { fetched: tally.fetched, resetAt: retryAt.toISOString() });
      return { done: false };
    }
  }

  ctx.log("crawl.fetched", { ...tally, drained: false });
  return { done: false };
}

/**
 * 묶음 하나를 셋까지 함께 처리한다.
 *
 * 항목은 GitHub 요청을 보내는 순간 시작된다. GitHub 줄은 하나라서, 줄 맨 앞에서 예산과 한도를
 * 확인한 뒤에야 다음 항목을 집는다 — 그래서 예산이 끝나거나 한도에 걸린 뒤로는 새 요청이
 * 나가지 않는다. 어떻게 끝나든(예외 포함) 시작하지 않은 claim은 돌려준다. 안 돌려주면
 * 10분 동안 fetching에 묶였다가 회수되고, 그 사이 시도 횟수만 하나 먹는다.
 *
 * 판정 요청은 묶음당 한 번이다. 원본마다 부르면 잡 행 하나를 두고 경합한다.
 */
async function fetchBatch(
  entries: FrontierEntry[],
  ctx: JobContext<null>,
  docsGenerators: readonly string[],
  evidenceRequired: ReadonlySet<string>,
  oneAtATime: OneAtATime,
  tally: Tally,
): Promise<{ retryAt: Date | null; pauseReason: "rate_limited" | "auth_unavailable" | null }> {
  // 여러 칸이 함께 고치는 상태라 한 객체에 둔다
  const batch = {
    next: 0,
    stopped: false,
    retryAt: null as Date | null,
    pauseReason: null as "rate_limited" | "auth_unavailable" | null,
    needsJudgement: 0,
    /** 시작은 했지만 끝내지 못해 그대로 돌려줄 것 — 한도·예산 대기는 실패한 시도가 아니다 */
    giveBack: new Set<FrontierEntry>(),
  };

  const lane = async () => {
    try {
      for (;;) {
        const started = await oneAtATime(GITHUB_ORIGIN, async () => {
          if (batch.stopped || batch.next >= entries.length) return null;
          if (!ctx.hasBudget()) {
            batch.stopped = true;
            return null;
          }
          const entry = entries[batch.next++];
          const result = await getRepo(entry.repo);
          // 한도는 줄을 놓기 전에 알린다 — 뒤에 선 칸이 같은 한도에 요청을 또 쓰지 않도록
          if (!result.ok && (result.error.kind === "rate_limited" || result.error.kind === "auth_unavailable")) batch.stopped = true;
          return { entry, result };
        });
        if (!started) return;

        const outcome = await fetchEntry(started.entry, started.result, ctx, docsGenerators, evidenceRequired, oneAtATime);
        if (outcome.kind === "paused") {
          batch.stopped = true;
          if (!batch.retryAt || outcome.retryAt > batch.retryAt) batch.retryAt = outcome.retryAt;
          batch.pauseReason = outcome.reason;
          batch.giveBack.add(started.entry);
        } else if (outcome.kind === "deferred") {
          batch.stopped = true;
          batch.giveBack.add(started.entry);
        } else if (outcome.kind === "fetched") {
          tally.fetched++;
          if (outcome.needsJudgement) batch.needsJudgement++;
        } else if (outcome.kind === "skipped") {
          tally.skipped++;
        } else if (outcome.kind === "gated") {
          tally.gated++;
        } else if (outcome.kind === "failed") {
          tally.failed++;
        }
      }
    } catch (error) {
      // 한 칸이 잡 전체의 문제(리스 상실, DB 장애)로 멈추면 나머지도 새 항목을 집지 않는다
      batch.stopped = true;
      throw error;
    }
  };

  const lanes = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, lane));

  const unfinished = entries.filter((entry, index) => index >= batch.next || batch.giveBack.has(entry));
  if (unfinished.length > 0) {
    if (batch.retryAt) {
      if (ctx.lease) await crawl.deferFrontier(unfinished, batch.retryAt, ctx.lease);
      else await crawl.deferFrontier(unfinished, batch.retryAt);
    } else if (ctx.lease) await crawl.deferFrontier(unfinished, undefined, ctx.lease);
    else await crawl.deferFrontier(unfinished);
  }
  if (batch.needsJudgement > 0) {
    const lease = ctx.lease;
    if (lease) await db.transaction(async tx => {
      await assertJobLease(tx, lease);
      await requestJob("crawl-judge", tx);
    });
    else await requestJob("crawl-judge");
  }

  const failure = lanes.find((settled): settled is PromiseRejectedResult => settled.status === "rejected");
  if (failure) throw failure.reason;
  return { retryAt: batch.retryAt, pauseReason: batch.pauseReason };
}

type EntryOutcome =
  | { kind: "fetched"; needsJudgement: boolean }
  | { kind: "skipped" | "failed" | "lost" | "deferred" | "gated" }
  | { kind: "paused"; reason: "rate_limited" | "auth_unavailable"; retryAt: Date };

/** GitHub 응답을 받은 항목 하나를 끝낸다. 실패는 여기서 항목별로 남긴다 */
async function fetchEntry(
  entry: FrontierEntry,
  result: Awaited<ReturnType<typeof getRepo>>,
  ctx: JobContext<null>,
  docsGenerators: readonly string[],
  evidenceRequired: ReadonlySet<string>,
  oneAtATime: OneAtATime,
): Promise<EntryOutcome> {
  if (!result.ok) {
    if (result.error.kind === "rate_limited" || result.error.kind === "auth_unavailable") {
      return { kind: "paused", reason: result.error.kind,
        retryAt: result.error.resetAt ?? new Date(Date.now() + (result.error.kind === "auth_unavailable" ? 15 * 60_000 : 60_000)) };
    }
    if (result.error.kind === "not_found") {
      // 지워졌거나 비공개로 바뀌었다 — 다시 시도할 이유가 없다. 404 였다는 것을 남긴다(사람 대기열의 "레포 삭제됨")
      if (ctx.lease) await crawl.markFrontier(entry.repo, "skipped", entry, ctx.lease, crawl.SKIP_NOT_FOUND);
      else await crawl.markFrontier(entry.repo, "skipped", entry, undefined, crawl.SKIP_NOT_FOUND);
      return { kind: "skipped" };
    }
    const reason = result.error.kind === "http"
      ? `GitHub ${result.error.status}`
      : `GitHub ${result.error.kind}`;
    if (ctx.lease) await crawl.markFailed(entry.repo, reason, undefined, entry, ctx.lease);
    else await crawl.markFailed(entry.repo, reason, undefined, entry);
    return { kind: "failed" };
  }

  if (!ctx.hasBudget()) return { kind: "deferred" };
  const repoMeta = result.value;
  const homepage = typeof repoMeta.homepage === "string" ? normalizeUrl(repoMeta.homepage) : null;

  /**
   * 검색어가 AI 사용을 말하지 않는 신호(한국어 README 같은 언어 표식)는 레포에 AI 코딩 도구의 흔적이 있어야
   * 들여보낸다(ai-evidence-gate.ts). 페이지를 열기 전에 본다 — 흔적 없는 쪽(표본의 약 1/3)은 페이지·판정·심사
   * 비용을 쓰지 않는다. 원본(레포 메타)은 남기고 후보를 거절로 적어 어떤 신호가 얼마나 걸러지는지 셀 수 있게 한다.
   *
   * 처음 들어오는 레포에만 건다. 이미 후보가 있는 레포의 재수집(승인·보류 후보의 원본 갱신, 관리자의 근거 재수집)은
   * 같은 신호로 다시 여기 오는데, 관문을 다시 걸면 심사 중인 후보를 잠금·상태 확인 없이 거절로 덮었다 —
   * 2026-10-05~06 1차 AI 승인을 받은 후보 237건이 그렇게 거절됐다. 그런 후보는 이미 심사(1·2차)가 흔적을 함께 본다.
   */
  let evidence: string[] | null = null;
  if (homepage && evidenceRequired.has(entry.signal) && !(await crawl.getCandidate(entry.repo))) {
    const probe = await oneAtATime(GITHUB_ORIGIN, () => probeAiEvidence(entry.repo));
    if (!probe.ok) {
      if (probe.error.kind === "rate_limited" || probe.error.kind === "auth_unavailable") {
        return { kind: "paused", reason: probe.error.kind,
          retryAt: probe.error.resetAt ?? new Date(Date.now() + (probe.error.kind === "auth_unavailable" ? 15 * 60_000 : 60_000)) };
      }
      if (probe.error.kind === "not_found") {
        // 빈 레포 — 볼 것이 없다. 삭제와 섞이지 않게 까닭을 따로 남긴다
        if (ctx.lease) await crawl.markFrontier(entry.repo, "skipped", entry, ctx.lease, crawl.SKIP_EMPTY_REPOSITORY);
        else await crawl.markFrontier(entry.repo, "skipped", entry, undefined, crawl.SKIP_EMPTY_REPOSITORY);
        return { kind: "skipped" };
      }
      const reason = `AI 흔적 확인 실패 — GitHub ${probe.error.kind === "http" ? probe.error.status : probe.error.kind}`;
      if (ctx.lease) await crawl.markFailed(entry.repo, reason, undefined, entry, ctx.lease);
      else await crawl.markFailed(entry.repo, reason, undefined, entry);
      return { kind: "failed" };
    }
    if (probe.found.length === 0) {
      const saved = await crawl.saveFetchedDocument(entry, {
        repo: entry.repo, repoMeta, productUrl: homepage, pageStatus: null, pageMeta: null,
      }, ctx.lease);
      if (!saved) {
        ctx.log("crawl.fetch_claim_lost", { repo: entry.repo });
        return { kind: "lost" };
      }
      if (saved.duplicateOf) {
        ctx.log("crawl.fetch_repository_alias", { repo: entry.repo, existingRepo: saved.duplicateOf });
        return { kind: "skipped" };
      }
      // 판정 잡이 집기 전에 거절로 적는다 — 판정 대기열은 후보가 없거나 new 인 원본만 본다
      await crawl.recordJudgement({
        repo: entry.repo, productUrl: homepage, state: "rejected", reason: "ai_evidence_not_found", decidedBy: "auto",
        signals: { evidenceGate: { signal: entry.signal, recentCommits: PROBE_COMMITS, found: [] } },
      });
      return { kind: "gated" };
    }
    evidence = probe.found;
  }

  /**
   * 사이트 없는 스킬·플러그인·확장 — 저장소 안의 패키지 파일을 찾아 원본에 붙인다(package-proof.ts).
   * 500 스타 이상은 이미 설치형으로 보고, 5 스타 미만·포크·보관된 것은 보지 않는다(하루 약 200건).
   */
  let meta = repoMeta;
  const stars = typeof repoMeta.stargazers_count === "number" ? repoMeta.stargazers_count : 0;
  if (stars >= PACKAGE_MIN_STARS && stars < INSTALLABLE_MIN_STARS && repoMeta.fork !== true && repoMeta.archived !== true
    && lacksDeployment(entry.repo, homepage)) {
    const branch = typeof repoMeta.default_branch === "string" && repoMeta.default_branch ? repoMeta.default_branch : "HEAD";
    const probe = await oneAtATime(GITHUB_ORIGIN, () => probePackageManifests(entry.repo, branch));
    if (!probe.ok) {
      if (probe.error.kind === "rate_limited" || probe.error.kind === "auth_unavailable") {
        return { kind: "paused", reason: probe.error.kind,
          retryAt: probe.error.resetAt ?? new Date(Date.now() + (probe.error.kind === "auth_unavailable" ? 15 * 60_000 : 60_000)) };
      }
      // 빈 저장소는 404·409 로 답한다 — 패키지가 없을 뿐이다. 나머지는 이 항목만 다시 시도한다
      if (!(probe.error.kind === "not_found" || (probe.error.kind === "http" && probe.error.status === 409))) {
        const reason = `패키지 확인 실패 — GitHub ${probe.error.kind === "http" ? probe.error.status : probe.error.kind}`;
        if (ctx.lease) await crawl.markFailed(entry.repo, reason, undefined, entry, ctx.lease);
        else await crawl.markFailed(entry.repo, reason, undefined, entry);
        return { kind: "failed" };
      }
    } else if (probe.proof.length) {
      meta = { ...repoMeta, [PACKAGE_PROOF_KEY]: probe.proof };
      ctx.log("crawl.package_proof", { repo: entry.repo, stars, proof: probe.proof.map((item) => item.kind) });
    }
  }

  let page: Awaited<ReturnType<typeof visit>> | null = null;
  if (homepage) {
    try {
      page = await visit(homepage, docsGenerators, oneAtATime);
    } catch (error) {
      /**
       * 헤더를 받은 뒤 본문이 끊겼거나 기한을 넘겼다(fetchPage). 이 항목만의 실패다. 잡 전체로
       * 번지던 때는 markFailed가 불리지 않아, 항목이 fetching으로 남았다 10분 뒤 회수되기를
       * 반복했고 최대 시도 횟수가 영영 걸리지 않았다(codex 재현).
       */
      if (ctx.lease) await crawl.markFailed(entry.repo, `페이지 본문 수신 실패 — ${describeError(error)}`, undefined, entry, ctx.lease);
      else await crawl.markFailed(entry.repo, `페이지 본문 수신 실패 — ${describeError(error)}`, undefined, entry);
      return { kind: "failed" };
    }
  }

  const saved = await crawl.saveFetchedDocument(entry, {
    repo: entry.repo,
    repoMeta: meta,
    productUrl: page?.productUrl ?? homepage,
    pageStatus: page?.status ?? null,
    // 들여보낸 흔적은 원본에 남긴다 — 심사 화면이 "왜 들어왔나"를 볼 수 있게
    pageMeta: page?.meta ? { ...page.meta, ...(evidence ? { evidenceGate: { signal: entry.signal, found: evidence } } : {}) } : null,
  }, ctx.lease);
  if (!saved) {
    // 회수돼 다른 워커가 다시 꺼냈다 — 그쪽이 받은 것이 더 새것이다
    ctx.log("crawl.fetch_claim_lost", { repo: entry.repo });
    return { kind: "lost" };
  }
  if (saved.duplicateOf) {
    ctx.log("crawl.fetch_repository_alias", { repo: entry.repo, existingRepo: saved.duplicateOf });
    return { kind: "skipped" };
  }
  await requeueAfterAdminEvidenceRefresh(entry.repo, ctx.lease);
  return { kind: "fetched", needsJudgement: saved.needsJudgement };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

type OneAtATime = ReturnType<typeof originQueue>;

/**
 * 같은 origin에는 한 번에 하나만 보낸다.
 *
 * 셋이 함께 돌면 owner.github.io 아래 레포별 배포물처럼 한 사이트에 줄지어 있는 항목을
 * 동시에 두드리게 된다. 남의 서버에 몰아서 보내지 않도록 origin마다 줄을 세운다. 줄은 이
 * 실행 안에서만 유효하다 — 다른 프로세스까지 맞추려고 DB를 쓰지는 않는다.
 */
function originQueue() {
  const tails = new Map<string, Promise<void>>();
  return async function oneAtATime<T>(url: string, work: () => Promise<T>): Promise<T> {
    const origin = originOf(url);
    const previous = tails.get(origin) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    tails.set(origin, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (tails.get(origin) === tail) tails.delete(origin);
    }
  };
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

/**
 * 배포 URL을 확인한다.
 *
 * 닿지 않으면 상태를 0으로 남긴다. null은 "아직 확인 안 함"이라는 뜻이고, 판정은 그것을
 * 보류(needs_review)로 다룬다 — 확인해서 죽어 있는 것까지 사람에게 보내면 심사 큐가
 * 죽은 링크로 찬다.
 *
 * 리다이렉트로 도메인이 바뀌면 목적지를 기준값으로 삼는다. 메이커가 등록할 때와 같은
 * 기준이어야 "이미 등록된 URL"을 알아볼 수 있다.
 *
 * `<meta http-equiv="refresh">`도 리다이렉트다. HTTP 리다이렉트만 따라가면 껍데기를
 * 판정하게 되는데, 실측 509건 중 24건이 그랬고 목적지는 문서이기도 진짜 앱이기도 했다.
 * 한 번만 따라간다 — 사슬을 무한정 좇을 이유가 없고, 두 번 이상 튀는 것은 드물다.
 *
 * 내용을 실제로 읽은 주소(finalUrl)도 따로 남긴다. 기준값은 같은 호스트 안의 이동을 따라가지
 * 않으므로, 루트가 /docs/ 로 넘기면 판정은 문서의 제목·본문을 보면서 주소 규칙은 루트에
 * 걸었다(codex 재현). 기준값은 그대로 두고, 판정이 도착한 주소도 보게 한다(rules.ts).
 */
async function visit(url: string, docsGenerators: readonly string[], oneAtATime: OneAtATime) {
  let page = await oneAtATime(url, () => fetchPage(url, "background"));
  if (!page) return { productUrl: url, status: 0, meta: null };

  const hop = metaRefreshTarget(page.html, page.finalUrl);
  if (hop) {
    const next = await oneAtATime(hop, () => fetchPage(hop, "background"));
    // 목적지가 열리지 않으면 껍데기 쪽을 그대로 쓴다 — 없는 주소로 바꾸면 더 나쁘다
    if (next) page = next;
  }

  const productUrl = resolveCanonical(url, page.finalUrl);
  /**
   * 상대 경로는 실제로 받아온 주소(finalUrl) 기준으로 푼다. 기준값(productUrl)은 같은
   * 호스트 안의 경로 이동을 따라가지 않으므로, example.com → example.com/en/ 같은 경우
   * og:image의 상대 경로가 한 단계 위에서 풀려 404가 된다.
   */
  return {
    productUrl,
    status: page.status,
    meta: { ...extractPageMeta(page.html, page.finalUrl, docsGenerators),
      thumbnailHints: siteHints(page.html, page.finalUrl),
      repositoryKeys: extractSiteRepositoryKeys(page.html, page.finalUrl),
      githubLinks: extractGithubLinks(page.html, page.finalUrl),
      finalUrl: page.finalUrl },
  };
}
