import { inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryObservations, agentRepositoryScans, repositoryAiLevels, type RepositoryAiLevel } from '@/lib/db/schema';
import { githubGraphql, githubRequest } from '@/lib/crawl/github';
import type { RepositoryRef } from '@/lib/crawl/github-repositories';
import { agentObservationSchema, AGENT_DETECTOR_VERSION, type AgentObservation } from '@/lib/domain/evidence/agents/types';
import { isDevelopmentPath } from '@/lib/domain/evidence/agents/commit-changes';
import {
  AGENT_ROOT_DIRECTORIES, agentPullRequests, classifyAiLevel, commitAiClaims, scanEvidence, SERVICE_AGENT_APPS, toolFiles, WORKFLOW_AGENT_APPS,
  type AgentPullRequest, type ClassifyInput,
} from '@/lib/domain/evidence/ai-level';
import { AI_LEVEL_RULES_VERSION, isAiLevel, type AiLevel, type AiLevelEvidence } from '@/lib/domain/evidence/ai-level-labels';
import {
  AI_LEVEL_BATCH, aiLevelBatchQuery, aiLevelDetailQuery, parseAiLevelBatch, parseAiLevelDetail,
  type AiLevelDetail, type AiLevelDetailRequest, type RepositoryAiScan,
} from '@/lib/domain/evidence/ai-level-query';
import { assertJobLease } from '@/lib/jobs/control';
import type { JobContext, JobOutcome } from '@/lib/jobs/runner';

/**
 * AI 제작 근거 단계(ai-level.ts)를 저장소마다 판정해 repository_ai_levels 에 적고, 같은 저장소의 제품 ai_level 에 옮긴다(0063).
 *
 * 차례: 새로 수집한 후보(new·needs_review·approved)를 최신부터 → 이 규칙 판으로 아직 보지 않은 공개 제품을 최신부터 → 다시 볼 때가 된 것.
 * 공개 여부는 바꾸지 않는다(2026-10-10 운영자 결정) — 분류만 한다.
 *
 * 예산(2026-10-10 실측, 운영 토큰 하나): GraphQL 10개 묶음이 1점·3.5~4.5초 — 한 틱(예산 55초) 30초 안에서 묶음을 연다(60개 남짓).
 * 공개 3만 8천 개 첫 바퀴가 반나절, 그 뒤 사흘마다 다시 보면 하루 1만 3천 개(1,300점). GraphQL 점수가 MIN_REMAINING 아래면 접는다.
 * 2단계 커밋이 코드를 바꿨는지는 REST 커밋 한 건씩 봐야 해서(GraphQL 은 바뀐 파일을 주지 않는다) 틱마다 REST_PER_TICK 건까지만 —
 * 운영 토큰의 REST 시간당 5,000건은 근거 수집(agent-evidence-refresh)과 나눠 쓴다. 확인한 결과는 근거에 남겨 다시 묻지 않는다.
 */
/** unseenIdleUntil: 아직 안 본 공개 제품을 찾는 질의(3만 8천 행 정규식, 1초 남짓)를 이때까지 쉰다 — 다 봤을 때만 */
export type AiLevelCursor = { retryAfter?: string; unseenIdleUntil?: string };
type Request = typeof githubRequest;
type Graphql = typeof githubGraphql;

const DUE_LIMIT = 80;
const START_WITHIN_MS = 30_000;
/** REST 커밋 확인은 이때까지만 — 마지막 묶음(10초)·두 번째 질의(10초)와 기록까지 예산 55초 안에 끝난다 */
const REST_WITHIN_MS = 38_000;
const PAUSE_MS = 500;
const MIN_REMAINING = 1_000;
const REST_PER_TICK = 20;
/** 한 저장소에서 코드 변경을 확인할 표기 커밋 수(최신부터) */
const COMMIT_CHECKS_PER_REPOSITORY = 3;
/** 에이전트 PR 의 바뀐 파일을 볼 수(최신부터) */
const PR_CHECKS_PER_REPOSITORY = 3;
const HOUR = 60 * 60_000;
const RECHECK_MS = 72 * HOUR;
const PENDING_RETRY_MS = 6 * HOUR;
const ERROR_RETRY_MS = HOUR;

const PUBLIC = sql`('seeded', 'verified')`;
const ACTIVE_CANDIDATES = sql`('new', 'needs_review', 'approved')`;
/** products_repository_identity_idx 와 같은 식 — 저장소 키로 제품을 찾을 때 이 인덱스를 탄다 */
const PRODUCT_IDENTITY = sql`regexp_replace(regexp_replace(lower(rtrim(repo_url, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', '')`;
const PRODUCT_KEY = sql`lower(regexp_replace(repo_url, '^https://github.com/([^/]+/[^/#?]+?)([.]git)?/?$', '\\1'))`;

/**
 * 이번 틱에 볼 저장소 키 — 새 후보 → 새 공개 제품 → 다시 볼 때.
 * 안 본 공개 제품 찾기는 운영에서 1초 남짓(2026-10-10 실측, 공개 3만 8천 행 정규식) — skipUnseen 이면 건너뛴다. unseenExhausted: 그 질의가 모자라게 돌려줬다(다 봤다)
 */
export async function dueRepositories(limit = DUE_LIMIT, { skipUnseen = false } = {}): Promise<{ keys: string[]; unseenExhausted: boolean }> {
  const unseen = (keyed: ReturnType<typeof sql>) => sql`
    SELECT d.key FROM (${keyed}) d
    WHERE NOT EXISTS (SELECT 1 FROM repository_ai_levels r WHERE r.repository_key = d.key AND r.rules_version = ${AI_LEVEL_RULES_VERSION})
    ORDER BY d.recent DESC`;
  const keys: string[] = [];
  const add = (rows: { key: string }[]) => keys.push(...rows.map((row) => row.key).filter((key) => !keys.includes(key)));
  add(await db.execute<{ key: string }>(sql`${unseen(sql`
    SELECT lower(repo) AS key, max(id) AS recent FROM crawl_candidates
    WHERE state IN ${ACTIVE_CANDIDATES} AND repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' GROUP BY 1`)} LIMIT ${limit}`));
  let unseenExhausted = false;
  if (keys.length < limit && !skipUnseen) {
    const wanted = limit - keys.length;
    const fresh = await db.execute<{ key: string }>(sql`${unseen(sql`
      SELECT ${PRODUCT_KEY} AS key, max(id) AS recent FROM products
      WHERE status IN ${PUBLIC} AND repo_url ~ '^https://github.com/[^/]+/[^/#?]+/?$' GROUP BY 1`)} LIMIT ${wanted}`);
    unseenExhausted = fresh.length < wanted;
    add(fresh);
  }
  // 공개 제품이거나 아직 심사 중인 후보의 저장소만 다시 본다 — 내려간 제품·거절된 후보의 행은 그대로 둔다
  if (keys.length < limit) add(await db.execute<{ key: string }>(sql`
    WITH active AS (SELECT DISTINCT lower(repo) AS key FROM crawl_candidates WHERE state IN ${ACTIVE_CANDIDATES})
    SELECT r.repository_key AS key FROM repository_ai_levels r
    WHERE r.next_check_at <= now() AND r.rules_version = ${AI_LEVEL_RULES_VERSION}
      AND (r.repository_key IN (SELECT key FROM active)
        OR EXISTS (SELECT 1 FROM products WHERE status IN ${PUBLIC} AND ${PRODUCT_IDENTITY} = 'https://github.com/' || r.repository_key))
    ORDER BY r.next_check_at LIMIT ${limit - keys.length}`));
  return { keys: keys.filter((key) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(key)), unseenExhausted };
}

/** 기존 근거 수집의 마지막 루트 조사(완료·부분)에서 단계로 셀 개발 커밋 표기·도구 파일 */
async function scannedEvidence(keys: string[]) {
  const latest = await db.execute<{ id: number; repository_key: string }>(sql`
    SELECT DISTINCT ON (repository_key) id, repository_key FROM ${agentRepositoryScans}
    WHERE ${inArray(agentRepositoryScans.repositoryKey, keys)} AND scope = '' AND detector_version = ${AGENT_DETECTOR_VERSION}
      AND state IN ('complete', 'partial')
    ORDER BY repository_key, completed_at DESC NULLS LAST, id DESC`);
  const byScan = new Map(latest.map((row) => [row.id, row.repository_key]));
  const grouped = new Map<string, AgentObservation[]>();
  if (byScan.size) {
    const rows = await db.select({ scanId: agentRepositoryObservations.scanId, facts: agentRepositoryObservations.facts })
      .from(agentRepositoryObservations).where(inArray(agentRepositoryObservations.scanId, [...byScan.keys()]));
    for (const row of rows) {
      const parsed = agentObservationSchema.safeParse(row.facts);
      const key = byScan.get(row.scanId);
      if (parsed.success && key) grouped.set(key, [...(grouped.get(key) ?? []), parsed.data]);
    }
  }
  return new Map([...grouped].map(([key, observations]) => [key, scanEvidence(observations)]));
}

export type Previous = Pick<RepositoryAiLevel, 'level' | 'evidence' | 'rulesVersion'>;

/** 지난 판정에서 이미 확인한 것 — 병합된 PR·기본 브랜치의 커밋은 바뀌지 않으므로 다시 묻지 않는다(같은 규칙 판일 때만) */
function knownChecks(previous: Previous | undefined) {
  const evidence: AiLevelEvidence = previous?.rulesVersion === AI_LEVEL_RULES_VERSION ? previous.evidence : {};
  return {
    pullRequests: new Map((evidence.pullRequests ?? []).map((pr) => [pr.number, pr])),
    commits: (evidence.commits ?? []).filter((commit) => commit.basis !== 'scan'),
    otherPullRequests: new Set(evidence.nonDevelopment?.pullRequests ?? []),
    otherCommits: new Set(evidence.nonDevelopment?.commits ?? []),
  };
}

/** REST 커밋 한 건 — 바뀐 파일에 코드가 있는가. null 은 이번에 모름 */
async function commitChangesCode(request: Request, key: string, sha: string): Promise<boolean | null> {
  const result = await request<{ files?: Array<{ filename?: unknown }> }>(`/repos/${key}/commits/${sha}`, {}, { timeoutMs: 6_000 });
  if (!result.ok || result.status !== 200 || !result.value) return null;
  return (result.value.files ?? []).some((file) => typeof file.filename === 'string' && isDevelopmentPath(file.filename));
}

export type Judged = { key: string; level: AiLevel | null; clients: string[]; evidence: AiLevelEvidence; headSha: string | null; retryMs: number };
export type Failed = { key: string; error: 'not_found' | 'unknown'; retryMs: number; fallback?: ReturnType<typeof classifyAiLevel> };

type Loaders = {
  previous: (keys: string[]) => Promise<Map<string, Previous>>;
  scanned: (keys: string[]) => Promise<Map<string, ReturnType<typeof scanEvidence>>>;
};
/** 한 틱의 의존 — 확인 스크립트(scripts/ai-level-check.ts)는 운영 DB 대신 내보낸 근거를 넣는다 */
export type AiLevelTick = { request: Request; graphql: Graphql; restLeft: number; restUntil: number; load: Loaders };
type Tick = AiLevelTick;

async function previousLevels(keys: string[]): Promise<Map<string, Previous>> {
  const rows = await db.select({ key: repositoryAiLevels.repositoryKey, level: repositoryAiLevels.level,
    evidence: repositoryAiLevels.evidence, rulesVersion: repositoryAiLevels.rulesVersion }).from(repositoryAiLevels)
    .where(inArray(repositoryAiLevels.repositoryKey, keys));
  return new Map(rows.map((row) => [row.key, row]));
}
const DATABASE_LOADERS: Loaders = { previous: previousLevels, scanned: scannedEvidence };

/** 받은 저장소 하나를 판정한다 */
async function judge(tick: Tick, key: string, scan: RepositoryAiScan, detail: AiLevelDetail, prs: AgentPullRequest[],
  known: ReturnType<typeof knownChecks>, prior: ReturnType<typeof scanEvidence>): Promise<Judged> {
  const pullRequests: ClassifyInput['pullRequests'][number][] = prs.map((pr) => {
    if (known.pullRequests.has(pr.number)) return { ...pr, development: true };
    if (known.otherPullRequests.has(pr.number)) return { ...pr, development: false };
    const files = detail?.pullRequestFiles.get(pr.number);
    return { ...pr, development: files ? files.some(isDevelopmentPath) : null };
  });
  // 병합 PR 은 사라지지 않는다 — 지난번에 확인한 것은 이번 30개 밖으로 밀려나도 남긴다
  for (const [number, pr] of known.pullRequests) if (!prs.some((item) => item.number === number)) {
    pullRequests.push({ number, mergedAt: pr.mergedAt, agent: pr.agent, client: SERVICE_AGENT_APPS[pr.agent] ?? WORKFLOW_AGENT_APPS[pr.agent] ?? pr.agent,
      level: pr.level === 1 ? 1 : 2, development: true });
  }
  // 2단계 커밋: 표기가 있는 커밋을 최신부터. 1·2단계 PR 이나 기존 근거 수집의 개발 커밋이 이미 있으면 REST 로 묻지 않는다
  const claimed = scan.isFork ? [] : scan.commits.flatMap((commit) => commitAiClaims(commit).map((claim) => ({ sha: commit.sha, ...claim })));
  const commits: ClassifyInput['commits'][number][] = known.commits.map((commit) => ({ ...commit, development: true }));
  const otherCommits = new Set(known.otherCommits);
  const needCommits = !pullRequests.some((pr) => pr.development === true) && !prior.commits.length && !commits.length;
  let lookups = 0;
  for (const sha of [...new Set(claimed.map((claim) => claim.sha))]) {
    if (!needCommits || commits.length || lookups >= COMMIT_CHECKS_PER_REPOSITORY || tick.restLeft <= 0 || Date.now() > tick.restUntil) break;
    if (otherCommits.has(sha)) continue;
    lookups++; tick.restLeft--;
    const development = await commitChangesCode(tick.request, key, sha);
    if (development === false) otherCommits.add(sha);
    if (development) commits.push(...claimed.filter((claim) => claim.sha === sha).map((claim) => ({ sha, client: claim.client, basis: claim.basis, development: true })));
  }
  commits.push(...prior.commits.map((commit) => ({ ...commit, basis: 'scan' as const, development: true })));
  const files = [...toolFiles(scan.rootEntries), ...(detail ? toolFiles(detail.entries) : []), ...prior.files];
  const result = classifyAiLevel({ isFork: scan.isFork, pullRequests, commits, files });
  const nonDevelopment = {
    pullRequests: [...new Set([...known.otherPullRequests, ...pullRequests.filter((pr) => pr.development === false).map((pr) => pr.number)])].slice(-20),
    commits: [...otherCommits].slice(-20),
  };
  // 아직 묻지 못한 것(PR 파일·표기 커밋)이 남았으면 몇 시간 뒤 다시 본다
  const pending = pullRequests.some((pr) => pr.development === null)
    || (needCommits && !commits.length && claimed.some((claim) => !otherCommits.has(claim.sha)));
  return {
    key, level: result.level, clients: result.clients, headSha: scan.headSha, retryMs: pending ? PENDING_RETRY_MS : RECHECK_MS,
    evidence: { ...result.evidence, ...(nonDevelopment.pullRequests.length || nonDevelopment.commits.length ? { nonDevelopment } : {}) },
  };
}

/** 묶음 하나 — 첫 질의가 통째로 실패하면 하나씩 다시 묻는다(큰 저장소 하나가 GitHub 10초 상한을 넘겨 묶음을 막는다) */
export async function processBatch(tick: Tick, batch: string[]): Promise<{ judged: Judged[]; failed: Failed[]; remaining: number | null; rateLimitedUntil?: string }> {
  const refs: RepositoryRef[] = batch.map((key) => { const [owner, name] = key.split('/'); return { owner, name }; });
  const answer = await tick.graphql<Record<string, unknown>>(aiLevelBatchQuery(refs), { timeoutMs: 10_000 });
  if (!answer.ok && answer.error.kind === 'rate_limited') {
    return { judged: [], failed: [], remaining: 0, rateLimitedUntil: new Date(answer.error.resetAt?.getTime() ?? Date.now() + 15 * 60_000).toISOString() };
  }
  if (!answer.ok || !answer.data) {
    if (batch.length === 1) return { judged: [], failed: [{ key: batch[0], error: 'unknown', retryMs: ERROR_RETRY_MS }], remaining: null };
    const parts = { judged: [] as Judged[], failed: [] as Failed[], remaining: null as number | null };
    for (const key of batch) {
      const one = await processBatch(tick, [key]);
      if (one.rateLimitedUntil) return { ...parts, remaining: 0, rateLimitedUntil: one.rateLimitedUntil };
      parts.judged.push(...one.judged); parts.failed.push(...one.failed); parts.remaining = one.remaining ?? parts.remaining;
    }
    return parts;
  }
  const answers = parseAiLevelBatch(refs, answer.data, answer.errors);
  const previous = await tick.load.previous(batch);
  const scanned = await tick.load.scanned(batch);

  // 두 번째 질의: 루트의 에이전트 폴더와, 아직 바뀐 파일을 보지 않은 에이전트 PR
  const plans = answers.map((item, index) => {
    if (item.kind !== 'found') return null;
    const known = knownChecks(previous.get(batch[index]));
    const prs = agentPullRequests(item.scan.pullRequests, item.scan.defaultBranch);
    const unchecked = prs.filter((pr) => !known.pullRequests.has(pr.number) && !known.otherPullRequests.has(pr.number)).slice(0, PR_CHECKS_PER_REPOSITORY);
    const present = new Set(item.scan.rootEntries.filter((entry) => entry.type === 'tree').map((entry) => entry.path));
    const detail: AiLevelDetailRequest = { repo: refs[index], directories: AGENT_ROOT_DIRECTORIES.filter((directory) => present.has(directory)),
      pullRequests: unchecked.map((pr) => pr.number) };
    return { scan: item.scan, known, prs, detail };
  });
  const wanted = plans.flatMap((plan, index) => plan && (plan.detail.directories.length || plan.detail.pullRequests.length) ? [index] : []);
  const details = new Map<number, AiLevelDetail>();
  if (wanted.length) {
    const requests = wanted.map((index) => plans[index]!.detail);
    const result = await tick.graphql<Record<string, unknown>>(aiLevelDetailQuery(requests), { timeoutMs: 10_000 });
    if (result.ok && result.data) parseAiLevelDetail(requests, result.data).forEach((detail, at) => details.set(wanted[at], detail));
  }

  const judged: Judged[] = [];
  const failed: Failed[] = [];
  for (const [index, item] of answers.entries()) {
    const key = batch[index];
    const plan = plans[index];
    if (item.kind === 'not_found') {
      // 저장소가 지금은 없다 — 지난 판정이 없고 기존 근거 수집이 찾은 근거가 있으면 그것으로 단계를 세운다(근거는 사라지지 않았다)
      const prior = scanned.get(key);
      const before = previous.get(key);
      const fromScan = prior && !isAiLevel(before?.level) ? classifyAiLevel({ isFork: false, pullRequests: [],
        commits: prior.commits.map((commit) => ({ ...commit, basis: 'scan' as const, development: true })), files: prior.files }) : null;
      failed.push({ key, error: 'not_found', retryMs: RECHECK_MS, ...(fromScan?.level ? { fallback: fromScan } : {}) });
    }
    else if (!plan) failed.push({ key, error: 'unknown', retryMs: ERROR_RETRY_MS });
    // 폴더·PR 을 묻는 두 번째 질의가 실패했으면 반쪽 판정을 적지 않는다 — 한 시간 뒤 다시
    else if (wanted.includes(index) && !details.has(index)) failed.push({ key, error: 'unknown', retryMs: ERROR_RETRY_MS });
    else judged.push(await judge(tick, key, plan.scan, details.get(index) ?? null, plan.prs, plan.known, scanned.get(key) ?? { commits: [], files: [] }));
  }
  const limit = answer.data.rateLimit;
  const remaining = limit && typeof limit === 'object' && typeof (limit as { remaining?: unknown }).remaining === 'number' ? (limit as { remaining: number }).remaining : null;
  return { judged, failed, remaining };
}

export async function refreshAiLevelsJob(ctx: JobContext<AiLevelCursor>, dependencies: { graphql?: Graphql; request?: Request } = {}): Promise<JobOutcome<AiLevelCursor>> {
  if (ctx.cursor?.retryAfter && Date.parse(ctx.cursor.retryAfter) > Date.now()) return { done: true, cursor: ctx.cursor };
  const started = Date.now();
  const tick: Tick = { graphql: dependencies.graphql ?? githubGraphql, request: dependencies.request ?? githubRequest, restLeft: REST_PER_TICK,
    restUntil: started + REST_WITHIN_MS, load: DATABASE_LOADERS };
  const skipUnseen = Boolean(ctx.cursor?.unseenIdleUntil && Date.parse(ctx.cursor.unseenIdleUntil) > Date.now());
  const { keys, unseenExhausted } = await dueRepositories(DUE_LIMIT, { skipUnseen });
  // 안 본 공개 제품을 다 봤으면 10분 쉰다 — 크롤러로 새로 들어오는 제품은 후보 때 이미 판정된다(1번 차례)
  const idle = skipUnseen ? { unseenIdleUntil: ctx.cursor!.unseenIdleUntil } : unseenExhausted ? { unseenIdleUntil: new Date(Date.now() + 10 * 60_000).toISOString() } : {};
  let checked = 0;
  for (let start = 0; start < keys.length; start += AI_LEVEL_BATCH) {
    if (!ctx.hasBudget() || Date.now() - started > START_WITHIN_MS) break;
    const result = await processBatch(tick, keys.slice(start, start + AI_LEVEL_BATCH));
    await record(ctx, result.judged, result.failed);
    checked += result.judged.length + result.failed.length;
    if (result.rateLimitedUntil) {
      ctx.log('ai_level.rate_limited', { retryAfter: result.rateLimitedUntil });
      return { done: true, cursor: { retryAfter: result.rateLimitedUntil, ...idle } };
    }
    if (result.remaining !== null && result.remaining < MIN_REMAINING) {
      ctx.log('ai_level.graphql_low', { remaining: result.remaining });
      return { done: true, cursor: { retryAfter: new Date(Date.now() + 15 * 60_000).toISOString(), ...idle } };
    }
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }
  ctx.log('ai_level.tick', { checked, due: keys.length, restUsed: REST_PER_TICK - tick.restLeft });
  return { done: checked >= keys.length, cursor: Object.keys(idle).length ? idle : null };
}

/**
 * 판정을 적고 같은 저장소의 제품 ai_level 을 맞춘다 — 한 트랜잭션, 작업 리스 확인 뒤.
 * 실패: 지난 판정(단계·근거·확인 시각)은 그대로 두고 오류와 다음 시도 시각만 고친다. 처음 보는 저장소면 단계 없이 오류만 적은 행을 만든다
 * (ai-level-store.ts 는 이런 행을 '검사 전'으로 읽는다) — 같은 저장소가 매 틱 앞을 막지 않게 한다.
 */
async function record(ctx: JobContext<AiLevelCursor>, judged: Judged[], failed: Failed[]) {
  if (!judged.length && !failed.length) return;
  const now = new Date();
  await db.transaction(async (tx) => {
    if (ctx.lease) await assertJobLease(tx, ctx.lease);
    for (const item of failed) {
      const next = new Date(now.getTime() + item.retryMs);
      const fallback = item.fallback;
      await tx.insert(repositoryAiLevels).values({ repositoryKey: item.key, level: fallback?.level ?? null, clients: fallback?.clients ?? [],
        evidence: fallback?.evidence ?? {}, rulesVersion: AI_LEVEL_RULES_VERSION, headSha: null, checkedAt: now, nextCheckAt: next, lastError: item.error })
        .onConflictDoUpdate({ target: repositoryAiLevels.repositoryKey, set: { nextCheckAt: next, lastError: item.error, rulesVersion: AI_LEVEL_RULES_VERSION,
          ...(fallback ? { level: fallback.level, clients: fallback.clients, evidence: fallback.evidence, checkedAt: now } : {}) } });
      if (fallback) await tx.execute(sql`UPDATE products SET ai_level = ${fallback.level}
        WHERE ${PRODUCT_IDENTITY} = ${`https://github.com/${item.key}`} AND ai_level IS DISTINCT FROM ${fallback.level}`);
    }
    for (const item of judged) {
      const values = { repositoryKey: item.key, level: item.level, clients: item.clients, evidence: item.evidence, rulesVersion: AI_LEVEL_RULES_VERSION,
        headSha: item.headSha, checkedAt: now, nextCheckAt: new Date(now.getTime() + item.retryMs), lastError: null };
      await tx.insert(repositoryAiLevels).values(values).onConflictDoUpdate({ target: repositoryAiLevels.repositoryKey, set: values });
      await tx.execute(sql`UPDATE products SET ai_level = ${item.level}
        WHERE ${PRODUCT_IDENTITY} = ${`https://github.com/${item.key}`} AND ai_level IS DISTINCT FROM ${item.level}`);
    }
  });
}
