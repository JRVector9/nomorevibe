import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { fetchPage, readBodyCapped, safeFetch } from "@/lib/net/fetch";
import { extractPageMeta, extractTextSample, metaRefreshTarget } from "@/lib/net/normalize";
import { extractGithubLinks } from "@/lib/crawl/github-links";
import { classifyRepoResponse, decideGoneRepository, MAX_RELATED_LINKS, pageConclusive, relatedRepositoryLinks, repositoryKey,
  type RepoCheck, type RepoReviewPage } from "@/lib/domain/products/repo-review";
import { delistGoneRepository, dueRepoReviews, MAX_REPO_GONE_DELISTS_PER_DAY, repoGoneDelistsLastDay, saveRepoReview,
  type RepoReviewRecord, type RepoReviewTarget } from "@/lib/domain/products/repo-reviews";

/**
 * 저장소가 사라진 공개 제품을 다시 본다 — github.com 을 지금 열어 정말 없으면 내린다(repo-review.ts).
 *
 * text 워커에서 5분마다 8건까지, 셋씩 동시에. 한 건은 github.com 한 번, 저장소가 없으면 제품 페이지 한 번과
 * 같은 프로젝트로 보이는 링크 최대 셋이다. 페이지를 못 열었으면(연결 실패·막힘·서버 오류) 사이트가 사흘 넘게 죽어 있지 않은 한
 * 내리지 않는다 — 옮겨 간 저장소 링크가 그 페이지에 있었을 수 있다. GitHub 로그인은 쓰지 않는다 — 공개 페이지가 열리는지만 본다(비공개도 404).
 * github.com 이 막히면(429·5xx·연결 실패) 그 제품은 적지 않고 다음 틱에 다시 본다 — 잇따라 둘이 막히면 이번 틱을 접는다.
 * 내리는 것은 하루 MAX_REPO_GONE_DELISTS_PER_DAY 건까지다. 넘으면 내릴 후보로 적어 운영자에게 넘긴다.
 */
const BATCH = 8;
const CONCURRENCY = 3;
/** 틱 예산(worker.ts jobRunOptions 55초)보다 조금 짧게 */
const TICK_MS = 50_000;
/** 페이지 열기(10초)와 github.com 몇 번을 끝낼 시간이 남았을 때만 새 건을 시작한다 */
const MIN_START_MS = 25_000;
const PAGE_BYTES = 256 * 1024;
const EXCERPT_CHARS = 500;

/** 생존 확인(uptime.ts)과 같은 규칙으로 연다 — 같은 SSRF 가드, meta refresh 한 번 따라가기, 256KB 까지 */
export async function openProductPage(url: string): Promise<RepoReviewPage> {
  const fetched = await safeFetch(url, "background");
  if (!fetched) return { status: 0, finalUrl: null, title: "", text: "", githubLinks: [], complete: false };
  let status = fetched.response.status;
  try {
    const body = await readBodyCapped(fetched.response, PAGE_BYTES);
    let html = body.toString("utf-8");
    let finalUrl = fetched.finalUrl;
    // 상한에서 잘렸으면 뒤쪽 링크를 못 본 것이다
    let complete = body.length < PAGE_BYTES;
    const hop = status >= 200 && status < 400 ? metaRefreshTarget(html, finalUrl) : null;
    if (hop) {
      const next = await fetchPage(hop, "background");
      // 넘어간 곳을 못 열었으면 남은 것은 빈 안내 페이지뿐이다 — 링크를 못 본 것으로 둔다. 넘어간 곳도 같은 상한으로 본다
      if (!next) complete = false;
      else { html = next.html; finalUrl = next.finalUrl; status = next.status; complete = complete && Buffer.byteLength(html, "utf-8") < PAGE_BYTES; }
    }
    return { status, finalUrl, title: extractPageMeta(html, finalUrl).title ?? "", text: extractTextSample(html) ?? "",
      githubLinks: extractGithubLinks(html, finalUrl), complete };
  } catch {
    // 본문을 못 읽어도 응답 코드는 안다 — 링크를 못 본 것이지 링크가 없는 것은 아니다
    return { status, finalUrl: fetched.finalUrl, title: "", text: "", githubLinks: [], complete: false };
  }
}

/** github.com/owner/repo 를 로그인 없이 연다 — 이름을 바꾼 저장소는 새 주소로 넘어간다(safeFetch 가 따라간다) */
export async function checkGithubRepository(key: string): Promise<RepoCheck> {
  const fetched = await safeFetch(`https://github.com/${key}`, "background");
  if (!fetched) return { state: "unknown" };
  await fetched.response.body?.cancel().catch(() => {});
  return classifyRepoResponse(key, fetched.response.status, fetched.finalUrl);
}

type Dependencies = { openPage?: (url: string) => Promise<RepoReviewPage>; checkRepo?: (key: string) => Promise<RepoCheck> };

export async function reviewGoneRepositories(ctx: JobContext<null>, dependencies: Dependencies = {}): Promise<JobOutcome<null>> {
  const startedAt = Date.now();
  const remaining = () => TICK_MS - (Date.now() - startedAt);
  const targets = await dueRepoReviews(BATCH);
  if (targets.length === 0) {
    ctx.log("repo_review.idle", { reviewed: 0 });
    return { done: true };
  }
  const openPage = dependencies.openPage ?? openProductPage;
  const checkRepo = dependencies.checkRepo ?? checkGithubRepository;
  let delistsLeft = Math.max(0, MAX_REPO_GONE_DELISTS_PER_DAY - await repoGoneDelistsLastDay());
  const counts = { keep: 0, human: 0, delist_candidate: 0, delisted: 0, capped: 0, operatorKeep: 0, unknown: 0 };
  let blocked = false, inARow = 0, next = 0;
  // 쓰기는 한 번에 하나 — text 워커의 DB 풀(3)에 러너 임대 갱신 몫을 남긴다(uptime.ts 와 같은 까닭)
  let writing: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T,>(write: () => Promise<T>) => {
    const run = writing.then(write);
    writing = run.catch(() => {});
    return run;
  };
  /** github.com 이 답하지 않았다 — 적지 않고 다음 틱에. 잇따라 둘이면 이번 틱을 접는다 */
  const unknown = () => { counts.unknown++; if (++inARow >= 2) blocked = true; };

  const review = async (target: RepoReviewTarget) => {
    const repo = repositoryKey(target.repoUrl);
    const record = (decision: RepoReviewRecord["decision"], reason: string, page: RepoReviewPage | null, note: string | null): RepoReviewRecord => ({
      productId: target.id, decision, reason, answers: null, model: null, pageHttpStatus: page?.status ?? null, finalUrl: page?.finalUrl ?? null,
      pageTitle: page?.title || null, pageExcerpt: note ?? (page?.text ? page.text.slice(0, EXCERPT_CHARS) : null),
    });
    const save = (value: RepoReviewRecord) => oneAtATime(() => saveRepoReview(value, ctx.lease)).then(() => { counts[value.decision]++; });
    // 하루 확인(stars-refresh)은 github.com/owner/repo 꼴만 묻는다 — 그 밖의 주소는 사라졌다고 판정될 일이 없다
    if (!repo) return save(record("human", "repo_unparsable", null, target.repoUrl));

    const own = await checkRepo(repo);
    if (own.state === "unknown") return unknown();
    inARow = 0;
    if (own.state === "alive") return save(record("keep", "repo_alive", null, null));
    if (own.state === "moved") return save(record("human", "repo_moved", null, `github.com/${own.to}`));

    const page = await openPage(target.url);
    if (!pageConclusive(page, target.downSince)) return save(record("human", "page_unavailable", page, null));
    const keys = relatedRepositoryLinks({ repo, name: target.name, url: target.url, renamedTo: target.renamedTo }, page);
    const related: { key: string; check: RepoCheck }[] = [];
    for (const key of keys.slice(0, MAX_RELATED_LINKS)) {
      if (blocked || ctx.signal?.aborted) return;
      const check = await checkRepo(key);
      if (check.state === "unknown") return unknown();
      related.push({ key, check });
    }
    const decided = decideGoneRepository(related, keys.slice(MAX_RELATED_LINKS));
    if (!decided) return;
    if (decided.decision !== "delist_candidate") return save(record(decided.decision, decided.reason, page, decided.note));
    // 운영자가 전에 '유지'를 골랐거나 하루 한도를 넘었으면 내리지 않고 운영자에게
    if (target.operatorDecision === "keep" || delistsLeft <= 0) {
      if (delistsLeft <= 0) counts.capped++;
      return save(record("delist_candidate", "repo_gone", page, null));
    }
    delistsLeft--;
    const outcome = await oneAtATime(() => delistGoneRepository({ ...record("delist_candidate", "repo_gone", page, null), slug: target.slug }, ctx.lease));
    if (outcome === "delisted") counts.delisted++;
    else if (outcome === "operator_keep") counts.operatorKeep++;
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
    ctx.log("repo_review.blocked", { error: "github_unavailable", ...counts });
    return { done: true };
  }
  if (counts.capped) ctx.log("repo_review.capped", { limit: MAX_REPO_GONE_DELISTS_PER_DAY, ...counts });
  ctx.log("repo_review.reviewed", counts);
  return { done: targets.length < BATCH };
}
