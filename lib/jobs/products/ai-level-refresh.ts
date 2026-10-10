import { inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryObservations, agentRepositoryScans, repositoryAiLevels, type RepositoryAiLevel } from '@/lib/db/schema';
import { githubGraphql, githubRequest } from '@/lib/crawl/github';
import type { RepositoryRef } from '@/lib/crawl/github-repositories';
import { agentObservationSchema, AGENT_DETECTOR_VERSION, type AgentObservation } from '@/lib/domain/evidence/agents/types';
import { isDevelopmentPath } from '@/lib/domain/evidence/agents/commit-changes';
import {
  AGENT_ROOT_DIRECTORIES, agentPullRequests, classifyAiLevel, commitAiClaims, scanEvidence, SERVICE_AGENT_APPS, toolFiles, WORKFLOW_AGENT_APPS,
  type AgentPullRequest, type ClassifyInput, type CommitClaim,
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
 * 한 틱은 둘로 나뉜다. ① GraphQL 10개 묶음(1점·3.5~4.5초)으로 판정 — 틱 30초 안에서 묶음을 연다. ② 남은 시간에 REST 로
 * 'AI 도구 표기는 있는데 코드를 바꿨는지 모르는' 커밋을 확인한다(GraphQL 은 커밋의 바뀐 파일을 주지 않는다). 확인 대기 커밋은 판정에
 * 남겨 두고 최근 판정한 저장소부터 틱마다 확인하므로, 새로 수집한 제품이 먼저 끝난다. 기존 근거 수집(agent_repository_observations)의
 * 커밋 표기도 그대로 믿지 않고 이 확인을 거친다 — 그 수집은 'Claude <사람@gmail.com>' 같은 표기를 주소 없이 도구로 셌다.
 *
 * 예산(운영 토큰 하나): GraphQL 은 첫 바퀴에 시간당 3,000점 남짓. REST 는 틱당 30건(시간당 1,800건 남짓) — 다른 잡이 시간당 1,400건을 쓴다.
 * 크롤러 안에서 따로 도는 줄(evidence)이라 다른 크롤러 잡을 기다리게 하지 않는다 — 첫 바퀴 뒤로는 사흘 지난 저장소만이라 틱이 짧다.
 */
/** unseenIdleUntil: 아직 안 본 공개 제품을 찾는 질의(3만 8천 행 정규식, 1초 남짓)를 이때까지 쉰다 — 다 봤을 때만 */
export type AiLevelCursor = { retryAfter?: string; unseenIdleUntil?: string };
type Request = typeof githubRequest;
type Graphql = typeof githubGraphql;

const DUE_LIMIT = 80;
/** 새 GraphQL 질의(묶음·하나씩 다시 묻기)를 여는 마감 — 마지막 질의(10초)·두 번째 질의(10초)까지 예산 55초 안 */
const START_WITHIN_MS = 30_000;
/** REST 커밋 확인을 새로 시작하는 마감 — 걸린 요청(6초)과 기록까지 예산 55초 안에 끝난다 */
const REST_WITHIN_MS = 44_000;
const PAUSE_MS = 500;
const MIN_REMAINING = 1_000;
/**
 * 틱마다 REST 로 확인할 표기 커밋 수 — 2026-10-10 운영 첫 시간 실측: 틱당 20건은 매 틱 다 쓰고도 표기 저장소 대부분이 확인을 못 받아
 * '근거 없음'으로 남았다(공개 표본 20개 중 18개). 따로 도는 줄(catalog lane evidence)로 옮긴 뒤 틱이 시간당 60번 남짓 — 30건이면 1,800건,
 * 다른 잡(시간당 1,400건 남짓)과 합쳐 토큰 하나의 시간당 5,000건 안이다. 수집 토큰을 더하면 올릴 수 있다
 */
const REST_PER_TICK = 30;
/** REST 확인을 한 번에 몇 개씩 — 차례로 하면 40건이 15초를 넘는다 */
const REST_CONCURRENCY = 8;
/** 저장해 둘 확인 대기 커밋 수(최신부터) */
const PENDING_CAP = 10;
/** 에이전트 PR 의 바뀐 파일을 한 번에 볼 수(1단계 후보부터) */
const PR_CHECKS_PER_REPOSITORY = 3;
/** 다시 묻지 않으려고 남기는 '코드 아님' 목록의 길이 — 지금 보는 창(PR·커밋 30개 + 기존 근거) 안의 것만 남긴다 */
const NON_DEVELOPMENT_CAP = 40;
const HOUR = 60 * 60_000;
const RECHECK_MS = 72 * HOUR;
const PENDING_RETRY_MS = 6 * HOUR;
/** 실패한 저장소는 한 시간 남짓 뒤 — 같이 실패한 묶음이 다음에도 같은 묶음으로 모이지 않게 30분 안에서 흩는다 */
const errorRetryMs = () => HOUR + Math.floor(Math.random() * 30 * 60_000);

const PUBLIC = sql`('seeded', 'verified')`;
const ACTIVE_CANDIDATES = sql`('new', 'needs_review', 'approved')`;
/** products_repository_identity_idx 와 같은 식 — 저장소 키로 제품을 찾을 때 이 인덱스를 탄다 */
const PRODUCT_IDENTITY = sql`regexp_replace(regexp_replace(lower(rtrim(repo_url, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', '')`;
/** 제품의 저장소 키 — 같은 정규화(http·www·대소문자·.git·끝 / 를 가리지 않는다)에서 owner/name 만. 다른 곳이면 null */
const PRODUCT_KEY = sql`substring(${PRODUCT_IDENTITY} from '^https://github[.]com/([^/]+/[^/#?]+)$')`;
/** 공개 제품이거나 아직 심사 중인 후보의 저장소인가(r = repository_ai_levels) */
const ELIGIBLE = sql`(r.repository_key IN (SELECT lower(repo) FROM crawl_candidates WHERE state IN ${ACTIVE_CANDIDATES})
  OR EXISTS (SELECT 1 FROM products WHERE status IN ${PUBLIC} AND ${PRODUCT_IDENTITY} = 'https://github.com/' || r.repository_key))`;

/**
 * 이번 틱에 볼 저장소 키 — 새 후보 → 새 공개 제품 → 다시 볼 때.
 * 안 본 공개 제품 찾기는 운영에서 1초 남짓(2026-10-10 실측, 공개 3만 8천 행 정규식) — skipUnseen 이면 건너뛴다. unseenExhausted: 그 질의가 모자라게 돌려줬다(다 봤다)
 */
export async function dueRepositories(limit = DUE_LIMIT, { skipUnseen = false } = {}): Promise<{ keys: string[]; unseenExhausted: boolean }> {
  const unseen = (keyed: ReturnType<typeof sql>) => sql`
    SELECT d.key FROM (${keyed}) d
    WHERE d.key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM repository_ai_levels r WHERE r.repository_key = d.key AND r.rules_version = ${AI_LEVEL_RULES_VERSION})
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
      WHERE status IN ${PUBLIC} AND repo_url IS NOT NULL GROUP BY 1`)} LIMIT ${wanted}`);
    unseenExhausted = fresh.length < wanted;
    add(fresh);
  }
  if (keys.length < limit) {
    // 내려간 제품·거절된 후보의 행은 다시 보지 않는다 — 다시 볼 때가 된 채로 두면 매 틱 앞에서 걸러 내느라 행이 쌓일수록 느려진다.
    // 한 달 뒤로 미뤄 둔다(그사이 다시 공개되면 지난 판정이 그대로 보이고, 한 달 뒤 다시 본다)
    await db.execute(sql`UPDATE repository_ai_levels SET next_check_at = now() + interval '30 days'
      WHERE repository_key IN (SELECT r.repository_key FROM repository_ai_levels r WHERE r.next_check_at <= now() AND NOT ${ELIGIBLE} LIMIT 500)`);
    add(await db.execute<{ key: string }>(sql`
      SELECT r.repository_key AS key FROM repository_ai_levels r
      WHERE r.next_check_at <= now() AND r.rules_version = ${AI_LEVEL_RULES_VERSION} AND ${ELIGIBLE}
      ORDER BY r.next_check_at LIMIT ${limit - keys.length}`));
  }
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
    commits: evidence.commits ?? [],
    otherPullRequests: new Set(evidence.nonDevelopment?.pullRequests ?? []),
    otherCommits: new Set(evidence.nonDevelopment?.commits ?? []),
  };
}

type Loaders = {
  previous: (keys: string[]) => Promise<Map<string, Previous>>;
  scanned: (keys: string[]) => Promise<Map<string, ReturnType<typeof scanEvidence>>>;
};
/** 한 틱의 의존과 마감 — 확인 스크립트(scripts/ai-level-check.ts)는 운영 DB 대신 내보낸 근거를 넣고 마감을 두지 않는다 */
export type AiLevelTick = { request: Request; graphql: Graphql; restLeft: number; startUntil: number; restUntil: number; load: Loaders };
type Tick = AiLevelTick;

async function previousLevels(keys: string[]): Promise<Map<string, Previous>> {
  const rows = await db.select({ key: repositoryAiLevels.repositoryKey, level: repositoryAiLevels.level,
    evidence: repositoryAiLevels.evidence, rulesVersion: repositoryAiLevels.rulesVersion }).from(repositoryAiLevels)
    .where(inArray(repositoryAiLevels.repositoryKey, keys));
  return new Map(rows.map((row) => [row.key, row]));
}
const DATABASE_LOADERS: Loaders = { previous: previousLevels, scanned: scannedEvidence };

export type Judged = { key: string; level: AiLevel | null; clients: string[]; evidence: AiLevelEvidence; headSha: string | null; retryMs: number };
export type Failed = { key: string; error: 'not_found' | 'unknown'; retryMs: number; fallback?: ReturnType<typeof classifyAiLevel> };

/** 받은 저장소 하나를 판정한다 — REST 는 쓰지 않는다. 코드를 바꿨는지 모르는 표기 커밋은 확인 대기(pendingCommits)로 남긴다 */
function judge(key: string, scan: RepositoryAiScan, detail: AiLevelDetail, prs: AgentPullRequest[],
  known: ReturnType<typeof knownChecks>, prior: ReturnType<typeof scanEvidence>): Judged {
  const pullRequests: ClassifyInput['pullRequests'][number][] = prs.map((pr) => {
    if (known.pullRequests.has(pr.number)) return { ...pr, development: true };
    if (known.otherPullRequests.has(pr.number)) return { ...pr, development: false };
    const files = detail?.pullRequestFiles.get(pr.number);
    // 바뀐 파일이 100개를 넘고 앞 100개에 코드가 없으면 모른다 — 뒤쪽(src/…)에 있을 수 있다
    return { ...pr, development: !files ? null : files.paths.some(isDevelopmentPath) ? true : files.more ? null : false };
  });
  // 병합 PR 은 사라지지 않는다 — 지난번에 확인한 것은 이번 30개 밖으로 밀려나도 남긴다
  for (const [number, pr] of known.pullRequests) if (!prs.some((item) => item.number === number)) {
    pullRequests.push({ number, mergedAt: pr.mergedAt, agent: pr.agent, client: SERVICE_AGENT_APPS[pr.agent] ?? WORKFLOW_AGENT_APPS[pr.agent] ?? pr.agent,
      level: pr.level === 1 ? 1 : 2, development: true });
  }
  // 2단계 커밋: 지난번에 확인한 개발 커밋이나 코드를 바꾼 에이전트 PR 이 없으면, 표기 커밋을 최신부터 확인 대기에 둔다 —
  // 이번에 읽은 커밋 30개의 표기가 먼저, 그다음 기존 근거 수집이 찾은 커밋(표기를 다시 확인한다). 코드를 바꿨는지는 틱 끝에 REST 로 본다
  const claimed = scan.isFork ? [] : scan.commits.flatMap((commit) => commitAiClaims(commit).map((claim) => ({ sha: commit.sha, ...claim })));
  const fromScan = scan.isFork ? [] : prior.commits.map((commit) => ({ sha: commit.sha, client: commit.client, basis: 'scan' as const }));
  const commits: ClassifyInput['commits'][number][] = known.commits.map((commit) => ({ ...commit, development: true }));
  const needCommits = !pullRequests.some((pr) => pr.development === true) && !commits.length;
  const pendingCommits = needCommits
    ? [...new Map([...claimed, ...fromScan].filter((claim) => !known.otherCommits.has(claim.sha)).map((claim) => [claim.sha, claim])).values()]
      .slice(0, PENDING_CAP).map(({ sha, client, basis }) => ({ sha, client, basis }))
    : [];
  const files = [...toolFiles(scan.rootEntries), ...(detail ? toolFiles(detail.entries) : []), ...prior.files];
  const result = classifyAiLevel({ isFork: scan.isFork, pullRequests, commits, files });
  // '코드 아님' 목록은 지금 보는 창 안의 것만 — 창 밖으로 밀려난 것을 들고 있으면 목록이 차서 창 안의 것을 잊고 다시 묻는다
  const windowShas = new Set([...scan.commits.map((commit) => commit.sha), ...prior.commits.map((commit) => commit.sha)]);
  const windowPullRequests = new Set(scan.pullRequests.map((pr) => pr.number));
  const nonDevelopment = {
    pullRequests: [...new Set([...known.otherPullRequests, ...pullRequests.filter((pr) => pr.development === false).map((pr) => pr.number)])]
      .filter((number) => windowPullRequests.has(number)).slice(-NON_DEVELOPMENT_CAP),
    commits: [...known.otherCommits].filter((sha) => windowShas.has(sha)).slice(-NON_DEVELOPMENT_CAP),
  };
  // 아직 파일을 못 본 에이전트 PR 중 단계를 올릴 수 있는 것만 — 1단계면 더 볼 것이 없다
  const pendingPullRequests = pullRequests.filter((pr) => pr.development === null && pr.level < (result.level ?? 4)).map((pr) => pr.number);
  return {
    key, level: result.level, clients: result.clients, headSha: scan.headSha, retryMs: pendingPullRequests.length ? PENDING_RETRY_MS : RECHECK_MS,
    evidence: { ...result.evidence, ...(nonDevelopment.pullRequests.length || nonDevelopment.commits.length ? { nonDevelopment } : {}),
      ...(pendingCommits.length ? { pendingCommits } : {}), ...(pendingPullRequests.length ? { pendingPullRequests } : {}) },
  };
}

/** REST 커밋 한 건 — 코드를 바꿨는가, 메시지·작성자의 AI 도구 표기. null 은 이번에 모름(다음 틱에 다시) */
async function readCommit(request: Request, key: string, sha: string): Promise<{ development: boolean; claims: CommitClaim[] } | null> {
  const result = await request<{ files?: Array<{ filename?: unknown }>; parents?: unknown[]; author?: { login?: unknown } | null;
    commit?: { message?: unknown; author?: { name?: unknown; email?: unknown } } }>(`/repos/${key}/commits/${sha}`, {}, { timeoutMs: 6_000 });
  // 없는 커밋(강제 푸시로 사라짐 등)은 확인할 수 없다 — 대기에서 뺀다
  if (!result.ok) return result.error.kind === 'http' && [404, 409, 422].includes(result.error.status) ? { development: false, claims: [] } : null;
  if (result.status !== 200 || !result.value) return null;
  const value = result.value;
  const text = (input: unknown) => typeof input === 'string' ? input : '';
  // 파일이 300개를 넘는 커밋은 앞 300개만 온다 — 그 안에 코드가 없으면 코드가 아닌 것으로 본다(대개 자료·의존성 묶음)
  const development = (value.files ?? []).some((file) => typeof file.filename === 'string' && isDevelopmentPath(file.filename));
  const claims = commitAiClaims({ sha, message: text(value.commit?.message), parents: Array.isArray(value.parents) ? value.parents.length : 1,
    authorName: text(value.commit?.author?.name), authorEmail: text(value.commit?.author?.email),
    authorLogin: typeof value.author?.login === 'string' ? value.author.login : null });
  return { development, claims };
}

type CommitCheck = { development: boolean; claims: CommitClaim[] } | null;

/** 표기 커밋들을 REST 로 읽는다 — REST_CONCURRENCY 개씩 함께. 마감·예산을 넘으면 묻지 않는다(결과 없음) */
export async function checkCommits(tick: Tick, items: readonly { key: string; sha: string }[]): Promise<Map<string, CommitCheck>> {
  const results = new Map<string, CommitCheck>();
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (tick.restLeft <= 0 || Date.now() > tick.restUntil) return;
      tick.restLeft--;
      results.set(`${item.key}@${item.sha}`, await readCommit(tick.request, item.key, item.sha));
    }
  };
  await Promise.all(Array.from({ length: Math.min(REST_CONCURRENCY, items.length) }, worker));
  return results;
}

type Verdict = { level: AiLevel | null; clients: string[]; evidence: AiLevelEvidence };

/**
 * 확인 결과를 판정에 더한다 — 코드를 바꿨고 지금 규칙의 AI 도구 표기가 있는 커밋이 하나라도 있으면 2단계(1단계는 그대로), 대기를 비운다.
 * 아닌 것은 다시 묻지 않게 nonDevelopment 로 옮기고, 묻지 못한 것은 대기에 남긴다.
 */
export function applyCommitChecks(row: Verdict, key: string, results: Map<string, CommitCheck>): Verdict {
  const pending = row.evidence.pendingCommits ?? [];
  const result = (sha: string) => results.get(`${key}@${sha}`);
  const confirmed = pending.flatMap((commit) => {
    const check = result(commit.sha);
    // 기존 근거 수집이 찾은 커밋은 이번에 읽은 표기로 도구를 정한다
    return check?.development && check.claims.length ? [{ sha: commit.sha, client: commit.basis === 'scan' ? check.claims[0].client : commit.client, basis: commit.basis }] : [];
  });
  const other = pending.filter((commit) => { const check = result(commit.sha); return check && !(check.development && check.claims.length); }).map((commit) => commit.sha);
  const left = confirmed.length ? [] : pending.filter((commit) => result(commit.sha) == null);
  const nonDevelopment = { pullRequests: row.evidence.nonDevelopment?.pullRequests ?? [],
    commits: [...(row.evidence.nonDevelopment?.commits ?? []), ...other].slice(-NON_DEVELOPMENT_CAP) };
  const evidence: AiLevelEvidence = { ...row.evidence, ...(confirmed.length ? { commits: [...confirmed, ...(row.evidence.commits ?? [])].slice(0, 5) } : {}),
    ...(nonDevelopment.pullRequests.length || nonDevelopment.commits.length ? { nonDevelopment } : {}) };
  if (left.length) evidence.pendingCommits = left; else delete evidence.pendingCommits;
  return {
    level: confirmed.length ? (row.level === 1 ? 1 : 2) : row.level,
    clients: confirmed.length ? [...new Set([...row.clients, ...confirmed.map((commit) => commit.client)])].sort() : row.clients,
    evidence,
  };
}

/** 두 번째 질의 — 통째로 실패하면 저장소 하나씩 다시(마감까지). 저장소 답이 비면 실패로 둔다 */
async function loadDetails(tick: Tick, requests: AiLevelDetailRequest[]): Promise<(AiLevelDetail | undefined)[]> {
  const result = await tick.graphql<Record<string, unknown>>(aiLevelDetailQuery(requests), { timeoutMs: 10_000 });
  if (result.ok && result.data) return parseAiLevelDetail(requests, result.data).map((detail) => detail ?? undefined);
  if (requests.length === 1) return [undefined];
  const details: (AiLevelDetail | undefined)[] = [];
  for (const request of requests) {
    if (Date.now() > tick.startUntil) { details.push(undefined); continue; }
    details.push((await loadDetails(tick, [request]))[0]);
  }
  return details;
}

/** 묶음 하나 — 첫 질의가 통째로 실패하면 마감까지 하나씩 다시 묻는다(큰 저장소 하나가 GitHub 10초 상한을 넘겨 묶음을 막는다). 마감 뒤의 저장소는 적지 않는다(다음 틱) */
export async function processBatch(tick: Tick, batch: string[]): Promise<{ judged: Judged[]; failed: Failed[]; remaining: number | null; rateLimitedUntil?: string }> {
  const refs: RepositoryRef[] = batch.map((key) => { const [owner, name] = key.split('/'); return { owner, name }; });
  const answer = await tick.graphql<Record<string, unknown>>(aiLevelBatchQuery(refs), { timeoutMs: 10_000 });
  if (!answer.ok && answer.error.kind === 'rate_limited') {
    return { judged: [], failed: [], remaining: 0, rateLimitedUntil: new Date(answer.error.resetAt?.getTime() ?? Date.now() + 15 * 60_000).toISOString() };
  }
  if (!answer.ok || !answer.data) {
    if (batch.length === 1) return { judged: [], failed: [{ key: batch[0], error: 'unknown', retryMs: errorRetryMs() }], remaining: null };
    const parts = { judged: [] as Judged[], failed: [] as Failed[], remaining: null as number | null };
    for (const key of batch) {
      if (Date.now() > tick.startUntil) break;
      const one = await processBatch(tick, [key]);
      if (one.rateLimitedUntil) return { ...parts, remaining: 0, rateLimitedUntil: one.rateLimitedUntil };
      parts.judged.push(...one.judged); parts.failed.push(...one.failed); parts.remaining = one.remaining ?? parts.remaining;
    }
    return parts;
  }
  const answers = parseAiLevelBatch(refs, answer.data, answer.errors);
  const previous = await tick.load.previous(batch);
  const scanned = await tick.load.scanned(batch);

  // 두 번째 질의: 루트의 에이전트 폴더와, 아직 바뀐 파일을 보지 않은 에이전트 PR(1단계 후보 먼저, 1단계를 이미 확인했으면 볼 것 없음)
  const plans = answers.map((item, index) => {
    if (item.kind !== 'found') return null;
    const known = knownChecks(previous.get(batch[index]));
    const prs = agentPullRequests(item.scan.pullRequests, item.scan.defaultBranch);
    const settled = [...known.pullRequests.values()].some((pr) => pr.level === 1);
    const unchecked = settled ? [] : prs.filter((pr) => !known.pullRequests.has(pr.number) && !known.otherPullRequests.has(pr.number))
      .sort((a, b) => a.level - b.level).slice(0, PR_CHECKS_PER_REPOSITORY);
    const present = new Set(item.scan.rootEntries.filter((entry) => entry.type === 'tree').map((entry) => entry.path));
    const detail: AiLevelDetailRequest = { repo: refs[index], directories: AGENT_ROOT_DIRECTORIES.filter((directory) => present.has(directory)),
      pullRequests: unchecked.map((pr) => pr.number) };
    return { scan: item.scan, known, prs, detail };
  });
  const wanted = plans.flatMap((plan, index) => plan && (plan.detail.directories.length || plan.detail.pullRequests.length) ? [index] : []);
  const details = new Map<number, AiLevelDetail>();
  if (wanted.length) {
    (await loadDetails(tick, wanted.map((index) => plans[index]!.detail))).forEach((detail, at) => { if (detail) details.set(wanted[at], detail); });
  }

  const judged: Judged[] = [];
  const failed: Failed[] = [];
  for (const [index, item] of answers.entries()) {
    const key = batch[index];
    const plan = plans[index];
    if (item.kind === 'not_found') {
      // 저장소가 지금은 없다 — 지난 판정이 없고 기존 근거 수집이 찾은 도구 파일이 있으면 그것으로 3단계를 세운다(커밋 표기는 다시 확인할 수 없어 쓰지 않는다)
      const prior = scanned.get(key);
      const before = previous.get(key);
      const fromScan = prior && !isAiLevel(before?.level) ? classifyAiLevel({ isFork: false, pullRequests: [], commits: [], files: prior.files }) : null;
      failed.push({ key, error: 'not_found', retryMs: RECHECK_MS, ...(fromScan?.level ? { fallback: fromScan } : {}) });
    }
    else if (!plan) failed.push({ key, error: 'unknown', retryMs: errorRetryMs() });
    // 폴더·PR 을 묻는 두 번째 질의가 실패했으면 반쪽 판정을 적지 않는다 — 한 시간 남짓 뒤 다시
    else if (wanted.includes(index) && !details.has(index)) failed.push({ key, error: 'unknown', retryMs: errorRetryMs() });
    else judged.push(judge(key, plan.scan, details.get(index) ?? null, plan.prs, plan.known, scanned.get(key) ?? { commits: [], files: [] }));
  }
  const limit = answer.data.rateLimit;
  const remaining = limit && typeof limit === 'object' && typeof (limit as { remaining?: unknown }).remaining === 'number' ? (limit as { remaining: number }).remaining : null;
  return { judged, failed, remaining };
}

/**
 * 확인 대기 커밋을 가진 저장소를 최근 판정한 것부터(새로 수집한 제품이 먼저 끝난다) 하나씩 확인해 적는다.
 * 한 저장소에서 틱마다 한 커밋 — 아니면 다음 틱에 그다음 커밋을 본다.
 */
async function verifyPendingCommits(ctx: JobContext<AiLevelCursor>, tick: Tick): Promise<number> {
  if (tick.restLeft <= 0 || Date.now() > tick.restUntil) return 0;
  const rows = await db.select({ key: repositoryAiLevels.repositoryKey, level: repositoryAiLevels.level, clients: repositoryAiLevels.clients,
    evidence: repositoryAiLevels.evidence }).from(repositoryAiLevels)
    .where(sql`${repositoryAiLevels.rulesVersion} = ${AI_LEVEL_RULES_VERSION} AND jsonb_array_length(coalesce(${repositoryAiLevels.evidence}->'pendingCommits', '[]'::jsonb)) > 0`)
    .orderBy(sql`${repositoryAiLevels.checkedAt} desc`).limit(tick.restLeft);
  if (!rows.length) return 0;
  const results = await checkCommits(tick, rows.map((row) => ({ key: row.key, sha: row.evidence.pendingCommits![0].sha })));
  const updates = rows.flatMap((row) => {
    if (!results.has(`${row.key}@${row.evidence.pendingCommits![0].sha}`)) return [];
    const next = applyCommitChecks({ level: isAiLevel(row.level) ? row.level : null, clients: row.clients, evidence: row.evidence }, row.key, results);
    return [{ key: row.key, ...next }];
  });
  if (!updates.length) return 0;
  await db.transaction(async (tx) => {
    if (ctx.lease) await assertJobLease(tx, ctx.lease);
    for (const item of updates) {
      await tx.update(repositoryAiLevels).set({ level: item.level, clients: item.clients, evidence: item.evidence })
        .where(sql`${repositoryAiLevels.repositoryKey} = ${item.key}`);
      await tx.execute(sql`UPDATE products SET ai_level = ${item.level}
        WHERE ${PRODUCT_IDENTITY} = ${`https://github.com/${item.key}`} AND ai_level IS DISTINCT FROM ${item.level}`);
    }
  });
  return updates.length;
}

export async function refreshAiLevelsJob(ctx: JobContext<AiLevelCursor>, dependencies: { graphql?: Graphql; request?: Request } = {}): Promise<JobOutcome<AiLevelCursor>> {
  if (ctx.cursor?.retryAfter && Date.parse(ctx.cursor.retryAfter) > Date.now()) return { done: true, cursor: ctx.cursor };
  const started = Date.now();
  const tick: Tick = { graphql: dependencies.graphql ?? githubGraphql, request: dependencies.request ?? githubRequest, restLeft: REST_PER_TICK,
    startUntil: started + START_WITHIN_MS, restUntil: started + REST_WITHIN_MS, load: DATABASE_LOADERS };
  const skipUnseen = Boolean(ctx.cursor?.unseenIdleUntil && Date.parse(ctx.cursor.unseenIdleUntil) > Date.now());
  const { keys, unseenExhausted } = await dueRepositories(DUE_LIMIT, { skipUnseen });
  // 안 본 공개 제품을 다 봤으면 10분 쉰다 — 크롤러로 새로 들어오는 제품은 후보 때 이미 판정된다(1번 차례)
  const idle = skipUnseen ? { unseenIdleUntil: ctx.cursor!.unseenIdleUntil } : unseenExhausted ? { unseenIdleUntil: new Date(Date.now() + 10 * 60_000).toISOString() } : {};
  let checked = 0;
  for (let start = 0; start < keys.length; start += AI_LEVEL_BATCH) {
    if (!ctx.hasBudget() || Date.now() > tick.startUntil) break;
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
  // 틱 끝에 REST 몫으로 확인 대기 커밋을 본다 — 이번 틱에 판정한 저장소가 먼저다
  const verified = await verifyPendingCommits(ctx, tick);
  ctx.log('ai_level.tick', { checked, due: keys.length, verified, restUsed: REST_PER_TICK - tick.restLeft });
  return { done: checked >= keys.length, cursor: Object.keys(idle).length ? idle : null };
}

/**
 * 판정을 적고 같은 저장소의 제품 ai_level 을 맞춘다 — 한 트랜잭션, 작업 리스 확인 뒤.
 * 실패: 지난 판정(단계·확인 시각)은 그대로 두고 오류와 다음 시도 시각만 고친다. 지난 판정이 옛 규칙 판이면 근거는 비운다 — 새 판 표시를 단
 * 채 옛 근거가 '이미 확인한 것'으로 다음 판정에 이어지지 않게. 처음 보는 저장소면 단계 없이 오류만 적은 행을 만든다
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
        .onConflictDoUpdate({ target: repositoryAiLevels.repositoryKey, set: {
          nextCheckAt: next, lastError: item.error, rulesVersion: AI_LEVEL_RULES_VERSION,
          evidence: fallback?.evidence ?? sql`CASE WHEN ${repositoryAiLevels.rulesVersion} = ${AI_LEVEL_RULES_VERSION} THEN ${repositoryAiLevels.evidence} ELSE '{}'::jsonb END`,
          ...(fallback ? { level: fallback.level, clients: fallback.clients, checkedAt: now } : {}) } });
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
