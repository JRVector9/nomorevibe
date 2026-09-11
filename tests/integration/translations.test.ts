import { beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, secondReviews, textTranslations } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { pendingTranslations, recordTranslations, translationProgress, translationsFor } from '@/lib/crawl/translations';
import { textHash } from '@/lib/crawl/translate';
import { ensureSchema } from './setup';

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(textTranslations);
  await db.delete(secondReviews);
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await saveSettings({ enabled: true }, 'fixture');
});

const EN_A = "The URL serves a documentation site (title 'File: README — ArchUnitRuby') for a Ruby gem. Not a usable app.";
const EN_B = "The pageText shows a login form (\"Email Senha Entrar\") gating an internal dashboard — a login wall is not a product.";
const KO = '제품이 아니라 문서·소개 페이지다';

/** AI 심사 기록 하나 — reason 은 outcome 에 둔다(자동 심사가 남기는 모양) */
async function attempt(repo: string, reason: string, at = new Date()) {
  let [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  if (!candidate) {
    await crawl.putDocument({ repo, productUrl: `https://${repo.split('/')[1]}.test`, pageStatus: 200,
      repoMeta: { description: '서비스', stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: 'User' } }, pageMeta: { title: '제품' } });
    await crawl.recordJudgement({ repo, productUrl: `https://${repo.split('/')[1]}.test`, state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto' });
    [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  }
  const input = await loadReviewInput(candidate, (await crawl.getDocument(repo))!, await getSettings());
  await db.insert(crawlReviewAttempts).values({
    candidateId: candidate.id, kind: 'automatic', state: 'succeeded', attemptNumber: 1,
    inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash,
    snapshot: input.snapshot, source: input.source, promptVersion: 'v', rulesVersion: 'v',
    provider: 'claude-cli', model: 'sonnet', startedAt: at, completedAt: at, validUntil: input.validUntil,
    outcome: { decision: 'reject', reason, evidenceIds: ['product'] },
  });
  return candidate;
}

it('영어 사유만 옮길 대상이고, 같은 글은 한 번이며, 최근 것부터다', async () => {
  await attempt('acme/old', EN_A, new Date(Date.now() - 3600_000));
  await attempt('acme/new', EN_B);
  await attempt('acme/dup', EN_A, new Date(Date.now() - 2 * 3600_000)); // 같은 글이 다른 후보에서도 나온다 — 가장 최근에 본 때로 줄 선다
  await attempt('acme/korean', KO);

  const pending = await pendingTranslations(10);
  expect(pending.map((row) => row.body)).toEqual([EN_B, EN_A]);
  // DB 의 해시와 JS 의 해시가 같다 — 화면은 JS 로 찾는다
  expect(pending.map((row) => row.hash)).toEqual([textHash(EN_B), textHash(EN_A)]);
});

it('2차 판단 사유도 옮긴다', async () => {
  const candidate = await attempt('acme/x', KO);
  await db.insert(secondReviews).values({ candidateId: candidate.id, repo: 'acme/x', trigger: 'ai_decided', firstDecision: 'reject',
    firstConfidence: 0.9, inputHash: 'h', status: 'needs_human', secondDecision: 'reject', secondReason: EN_B, model: 'opus' });
  expect((await pendingTranslations(10)).map((row) => row.body)).toEqual([EN_B]);
});

it('옮긴 글은 같은 글이면 다시 쓰고, 한 글자라도 다르면 새로 옮긴다', async () => {
  await attempt('acme/a', EN_A);
  await recordTranslations([{ hash: textHash(EN_A), translated: 'URL 은 Ruby gem 의 문서 사이트다.' }], 'gpt-oss');

  // 같은 글이 새 심사에서 또 나와도 옮길 대상이 아니다
  await attempt('acme/b', EN_A);
  expect(await pendingTranslations(10)).toEqual([]);
  expect((await translationsFor([EN_A])).get(EN_A)).toBe('URL 은 Ruby gem 의 문서 사이트다.');

  // 마침표 하나 다른 글은 다른 글이다
  const changed = EN_A.replace('Not a usable app.', 'Not a usable app!');
  await attempt('acme/c', changed);
  expect((await pendingTranslations(10)).map((row) => row.body)).toEqual([changed]);
  expect((await translationsFor([changed])).size).toBe(0);
});

it('실패한 글은 기다렸다가 다시 보고, 이미 옮긴 번역은 실패로 덮지 않는다', async () => {
  await attempt('acme/a', EN_A);
  await attempt('acme/b', EN_B);
  await recordTranslations([{ hash: textHash(EN_A), translated: null, error: 'timeout' }], 'gpt-oss');
  expect((await pendingTranslations(10)).map((row) => row.body)).toEqual([EN_B]);

  // 다시 볼 때가 되면 다시 올라온다 — 한 번 실패한 표시와 함께
  await db.update(textTranslations).set({ retryAt: sql`now() - interval '1 minute'` });
  expect((await pendingTranslations(10)).find((row) => row.body === EN_A)).toMatchObject({ attempts: 1 });

  await recordTranslations([{ hash: textHash(EN_A), translated: '문서 사이트다' }], 'gpt-oss');
  await recordTranslations([{ hash: textHash(EN_A), translated: null, error: 'timeout' }], 'gpt-oss');
  const [row] = await db.select().from(textTranslations).where(eq(textTranslations.sourceHash, textHash(EN_A)));
  expect(row).toMatchObject({ status: 'done', translated: '문서 사이트다' });
});

it('진행을 센다 — 옮길 글 중 몇 개를 옮겼고 몇 개가 실패했나', async () => {
  await attempt('acme/a', EN_A);
  await attempt('acme/b', EN_B);
  await attempt('acme/k', KO);
  await recordTranslations([{ hash: textHash(EN_A), translated: '문서 사이트다' }, { hash: textHash(EN_B), translated: null, error: 'timeout' }], 'gpt-oss');

  expect(await translationProgress()).toMatchObject({ total: 2, done: 1, failed: 1, pending: 1, lastHour: 1 });
  expect((await translationProgress()).lastSecondsAgo).toBeLessThan(60);
});
