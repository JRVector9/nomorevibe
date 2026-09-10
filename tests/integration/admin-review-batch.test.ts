import { createHash } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments } from '@/lib/db/schema';
import { listAdminReviewEntries, type AdminReviewVerdict } from '@/lib/crawl/admin-review';
import { loadAgentJudgeInputs } from '@/lib/crawl/admin-review-batch';
import { loadAgentJudgeInput } from '@/lib/crawl/agent-evidence';
import { factsFromRepoMeta, judge, pageFactsFromDocument } from '@/lib/crawl/rules';
import { mergeWithDefaults } from '@/lib/crawl/settings';
import { AGENT_DETECTOR_VERSION, type AgentObservation } from '@/lib/domain/evidence/agents/types';
import { ensureSchema, resetTables } from './setup';

/**
 * 심사 화면이 개발 근거를 후보마다 따로 읽지 않는지.
 *
 * 근거 강제 모드에서 후보마다 loadAgentJudgeInput() 을 부르면 완료 스캔이 있는 후보당 SELECT 4번,
 * 미완료 스캔만 있으면 5번이다 — 50건 화면이면 200~250번.
 */
const HOUR = 3_600_000;
const ROOT_SCOPE_HASH = createHash('sha256').update(JSON.stringify('')).digest('hex');
const enforced = mergeWithDefaults({ enabled: true, agentEvidence: { enabled: true, enforceEligibility: true } });
let commit = 0;

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
});

function observation(repo: string, sha: string, overrides: Partial<AgentObservation> = {}): AgentObservation {
  return { kind: 'model_config', client: 'claude-code', compatibleClients: [], modelDeveloper: 'anthropic',
    declaredModelId: 'claude-sonnet-4-5', gateway: null, routing: 'fixed', role: 'sonnet', scope: '',
    keyPath: 'model', ruleId: 'claude.settings.v1', sourcePath: '.claude/settings.json', commitSha: sha,
    blobSha: 'b'.repeat(40), sourceUrl: `https://github.com/${repo}/blob/${sha}/.claude/settings.json`, ...overrides };
}

/** 보류 후보 하나와 그 원본. 배포 페이지가 이 저장소를 가리킨다(같은 제품) */
async function held(repo: string, document: { fetchedAt?: Date; repositoryKeys?: unknown } = {}) {
  await db.insert(crawlDocuments).values({ repo, productUrl: `https://${repo.replace('/', '-').toLowerCase()}.test`, pageStatus: 200,
    repoMeta: { description: '배포한 서비스', stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: 'User' } },
    pageMeta: { title: '제품', repositoryKeys: document.repositoryKeys ?? [repo] }, fetchedAt: document.fetchedAt ?? new Date(Date.now() - HOUR) });
  await db.insert(crawlCandidates).values({ repo, productUrl: `https://${repo.replace('/', '-').toLowerCase()}.test`,
    state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto', judgedAt: new Date() });
}

/** 스캔 한 건과 그 관측. facts 는 검증 전 원문 그대로 넣는다 — 깨진 행을 helper 가 버리는지도 본다 */
async function scan(repo: string, values: Partial<typeof agentRepositoryScans.$inferInsert>, facts: unknown[] = []) {
  const sha = (++commit).toString(16).padStart(40, '0');
  const [row] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(1), repositoryKey: repo.toLowerCase(),
    commitSha: sha, detectorVersion: AGENT_DETECTOR_VERSION, scope: '', scopeHash: ROOT_SCOPE_HASH, state: 'complete',
    startedAt: new Date(Date.now() - 2 * HOUR), completedAt: new Date(Date.now() - HOUR), ...values }).returning();
  for (const [index, value] of facts.entries()) {
    await db.insert(agentRepositoryObservations).values({ scanId: row.id, observationKey: `${row.id}-${index}`,
      facts: (typeof value === 'function' ? value(sha) : value) as AgentObservation });
  }
  return row;
}

async function selectCount(run: () => Promise<unknown>): Promise<number> {
  const client = (globalThis as unknown as { pgClient: { unsafe: (...args: unknown[]) => unknown } }).pgClient;
  const spy = vi.spyOn(client, 'unsafe');
  try {
    await run();
    return spy.mock.calls.filter(([query]) => /^\s*select/i.test(String(query))).length;
  } finally {
    spy.mockRestore();
  }
}

it('근거 강제 화면의 SELECT 수가 후보 수에 비례하지 않는다', async () => {
  const measure = async (count: number) => {
    await resetTables();
    await db.delete(crawlCandidates);
    await db.delete(crawlDocuments);
    for (let index = 0; index < count; index += 1) {
      const repo = `batch/app-${index}`;
      await held(repo);
      await scan(repo, {}, [(sha: string) => observation(repo, sha)]);
    }
    return selectCount(() => listAdminReviewEntries(enforced, { state: 'needs_review' }));
  };
  const few = await measure(2);
  const many = await measure(12);
  expect({ few, many }).toEqual({ few, many: few });
});

/**
 * helper 가 고르는 갈래를 하나씩 깐다. 일괄판이 조건 하나라도 다르게 고르면 여기서 어긋난다.
 * (검출기 버전·범위 해시·최신 스캔 순서·완료 스캔 순서·관측 싣는 조건·원본 신선도·관계)
 */
async function everyBranch() {
  const valid = (repo: string) => (sha: string) => observation(repo, sha);
  await held('case/no-scan');
  await held('case/fresh-complete');
  await scan('case/fresh-complete', {}, [valid('case/fresh-complete'),
    (sha: string) => observation('case/fresh-complete', sha, { scope: 'packages/web' }), { kind: 'broken' }]);
  await held('case/stale-complete');
  await scan('case/stale-complete', { completedAt: new Date(Date.now() - 30 * HOUR) }, [valid('case/stale-complete')]);
  await held('case/error-complete');
  await scan('case/error-complete', { lastErrorCode: 'timeout' }, [valid('case/error-complete')]);
  // 완료 스캔 뒤에 시작한 미완료 스캔 — 최신은 미완료, 근거 스캔은 완료라 서로 달라 관측을 싣지 않는다
  await held('case/newer-partial');
  await scan('case/newer-partial', { startedAt: new Date(Date.now() - 3 * HOUR) }, [valid('case/newer-partial')]);
  await scan('case/newer-partial', { state: 'partial', startedAt: new Date(Date.now() - HOUR / 2), completedAt: null },
    [valid('case/newer-partial')]);
  await held('case/only-partial');
  await scan('case/only-partial', { state: 'partial', completedAt: null }, [valid('case/only-partial')]);
  await held('case/only-failed');
  await scan('case/only-failed', { state: 'failed', completedAt: null, lastErrorCode: 'timeout' }, [valid('case/only-failed')]);
  // 옛 검출기 스캔이 더 늦게 시작했다 — 화면은 이걸 먼저 읽지만 helper 는 현재 검출기 스캔을 고른다
  await held('case/old-detector-newer');
  await scan('case/old-detector-newer', { startedAt: new Date(Date.now() - 3 * HOUR) }, [valid('case/old-detector-newer')]);
  await scan('case/old-detector-newer', { detectorVersion: '2026-01-01.1', startedAt: new Date(Date.now() - HOUR / 2) },
    [valid('case/old-detector-newer')]);
  // 완료 시각이 비어 있는 완료 스캔 — completed_at DESC 는 NULL 을 먼저 둔다
  await held('case/complete-null-time');
  await scan('case/complete-null-time', { startedAt: new Date(Date.now() - HOUR / 2), completedAt: null },
    [valid('case/complete-null-time')]);
  await scan('case/complete-null-time', { startedAt: new Date(Date.now() - 3 * HOUR) }, [valid('case/complete-null-time')]);
  // 하위 범위만 스캔된 저장소 — 전체 범위 스캔이 없는 것과 같다
  await held('case/scoped-only');
  await scan('case/scoped-only', { scope: 'packages/web',
    scopeHash: createHash('sha256').update(JSON.stringify('packages/web')).digest('hex') },
  [(sha: string) => observation('case/scoped-only', sha, { scope: 'packages/web' })]);
  await held('case/conflict', { repositoryKeys: ['github:other/app'] });
  await scan('case/conflict', {}, [valid('case/conflict')]);
  await held('case/stale-document', { fetchedAt: new Date(Date.now() - 30 * HOUR) });
  await scan('case/stale-document', {}, [valid('case/stale-document')]);
  await held('case/no-keys', { repositoryKeys: 'not-an-array' });
  await held('Case/Mixed', { repositoryKeys: ['github:case/mixed', 'case/mixed'] });
  await scan('Case/Mixed', {}, [valid('case/mixed')]);
}

const otherDetector = mergeWithDefaults({ enabled: true,
  agentEvidence: { enabled: true, enforceEligibility: true, detectorVersion: '2026-01-01.1' } });

it('일괄 조회가 후보마다 부른 loadAgentJudgeInput() 과 같은 값을 낸다', async () => {
  await everyBranch();
  const documents = await db.select().from(crawlDocuments);
  for (const settings of [enforced, otherDetector]) {
    const batch = await loadAgentJudgeInputs(documents, settings);
    expect(batch.size).toBe(documents.length);
    for (const document of documents) {
      expect(batch.get(document.repo), `${document.repo} (${settings.agentEvidence.detectorVersion})`)
        .toEqual(await loadAgentJudgeInput(document, settings));
    }
  }
  // 갈래가 실제로 갈렸는지 — 모두 같은 값이면 위 비교가 아무것도 지키지 못한다
  const byRepo = await loadAgentJudgeInputs(documents, enforced);
  expect(byRepo.get('case/fresh-complete')).toMatchObject({ relationship: 'same_product', scanState: 'complete',
    observations: [expect.objectContaining({ scope: '' })] });
  expect(byRepo.get('case/stale-complete')?.scanState).toBe('pending');
  expect(byRepo.get('case/newer-partial')).toMatchObject({ scanState: 'partial', observations: [] });
  expect(byRepo.get('case/only-partial')?.observations).toHaveLength(1);
  expect(byRepo.get('case/conflict')?.relationship).toBe('conflict');
  expect(byRepo.get('case/stale-document')?.relationship).toBe('unknown');
  expect(byRepo.get('Case/Mixed')).toMatchObject({ relationship: 'same_product', scanState: 'complete' });
});

it('화면이 먼저 읽은 관측을 넘겨도 결과가 같다', async () => {
  await everyBranch();
  const documents = await db.select().from(crawlDocuments);
  // 화면의 스캔 조회와 같은 조건 — scope='' 인 최신 스캔(검출기 무관)
  const screenScans = await db.selectDistinctOn([agentRepositoryScans.repositoryKey]).from(agentRepositoryScans)
    .where(eq(agentRepositoryScans.scope, ''))
    .orderBy(agentRepositoryScans.repositoryKey, desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id));
  const loaded = { scanIds: screenScans.map(row => row.id), observations: await db.select().from(agentRepositoryObservations)
    .where(inArray(agentRepositoryObservations.scanId, screenScans.map(row => row.id))) };
  expect(await loadAgentJudgeInputs(documents, enforced, loaded)).toEqual(await loadAgentJudgeInputs(documents, enforced));
});

it('심사 화면의 판정이 후보마다 helper 로 다시 판정한 것과 같다', async () => {
  await everyBranch();
  const { entries } = await listAdminReviewEntries(enforced, { state: 'needs_review' });
  expect(entries).toHaveLength(14);
  for (const entry of entries) {
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, entry.candidate.repo));
    const expected = judge(factsFromRepoMeta(document.repo, document.repoMeta), pageFactsFromDocument(document),
      enforced, new Date(), await loadAgentJudgeInput(document, enforced));
    const verdict: AdminReviewVerdict = { trace: expected.trace, signals: expected.signals, cause: expected.cause ?? null,
      state: expected.state, reason: expected.reason,
      matchesStored: expected.state === entry.candidate.state && expected.reason === entry.candidate.reason };
    expect(entry.verdict, entry.candidate.repo).toEqual(verdict);
  }
  // 근거 갈래가 판정까지 갈렸는지
  expect(new Set(entries.map(entry => entry.verdict?.signals.agentEvidence && (entry.verdict.signals.agentEvidence as { reason: string }).reason)))
    .toEqual(new Set(['ai_evidence_pending', 'ai_evidence_supported', 'repository_relationship_conflict', 'ai_evidence_insufficient']));
});
