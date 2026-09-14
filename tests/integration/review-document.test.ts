import {beforeAll, beforeEach, expect, it, vi} from 'vitest';
import {db} from '@/lib/db';
import {crawlDocuments} from '@/lib/db/schema';
import {getDocument, putDocument} from '@/lib/crawl/repository';
import {loadReviewDocument} from '@/lib/crawl/jobs/review-document';
import {README_SAMPLE_VERSION} from '@/lib/crawl/readme';
import {ensureSchema} from './setup';
const mocks = vi.hoisted(() => ({fetch: vi.fn()}));
vi.mock('@/lib/crawl/readme', async original => ({...await original<typeof import('@/lib/crawl/readme')>(), fetchReadmeSample: mocks.fetch}));
beforeAll(() => ensureSchema());
beforeEach(async () => {vi.resetAllMocks(); await db.delete(crawlDocuments);});
async function document(meta: Record<string, unknown>) {
  await putDocument({repo: 'acme/readme', productUrl: 'https://demo.example', pageStatus: 200, pageMeta: meta, repoMeta: {}});
}
it('refreshes legacy cached text and records the normalization version', async () => {
  await document({readmeSample: 'Live demo'});
  mocks.fetch.mockResolvedValue('Live demo (https://app.example/)');
  const result = await loadReviewDocument('acme/readme');
  expect(result?.pageMeta).toMatchObject({readmeSample: 'Live demo (https://app.example/)', readmeSampleVersion: README_SAMPLE_VERSION});
  expect((await getDocument('acme/readme'))?.pageMeta).toEqual(result?.pageMeta);
});
it('does not fetch a current sample again, including known absence', async () => {
  await document({readmeSample: '', readmeSampleVersion: README_SAMPLE_VERSION});
  await loadReviewDocument('acme/readme');
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it('retains the previous sample without falsely upgrading its version on transient failure', async () => {
  await document({readmeSample: 'old'}); mocks.fetch.mockResolvedValue(null);
  expect((await loadReviewDocument('acme/readme'))?.pageMeta).toEqual({readmeSample: 'old'});
  expect((await getDocument('acme/readme'))?.pageMeta).toEqual({readmeSample: 'old'});
});
it('does not attach a fetched README to a document that changed during the request', async () => {
  await document({readmeSample: 'old'});
  mocks.fetch.mockImplementation(async () => {await document({title: 'new source'}); return 'stale fetch';});
  const result = await loadReviewDocument('acme/readme');
  expect(result?.pageMeta).toEqual({title: 'new source'});
  expect((await getDocument('acme/readme'))?.pageMeta).toEqual({title: 'new source'});
});
