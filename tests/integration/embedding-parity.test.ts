import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products, productEmbeddings } from '@/lib/db/schema';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_PREPROCESSING_HASH } from '@/lib/domain/products/embedding';
import { refreshProductEmbeddings } from '@/lib/jobs/products/embedding-refresh';
import { ensureSchema, resetTables, TEST_DATABASE_URL } from './setup';

/**
 * 임베딩 확인 표본 CLI(PR16b) — 실제 DB 의 저장 벡터(기존 product-embedding 잡이 쓴 것)를 읽고, 실제 자식 프로세스 CLI 가
 * loopback 가짜 서버로 다시 임베딩한다. DB 는 전후가 같아야 한다(쓰기 0). 운영자 env 처럼 EMBEDDING_SERVING_PROFILE= (빈 값,
 * 지금은 degraded) 이어도 측정은 한다 — 그 기록을 만들기 위한 도구이기 때문이다.
 */
/** 글 → 결정적 벡터(가짜 모델). 저장 때와 가짜 서버가 같은 함수를 쓰면 같은 공간이다 */
const vectorOf = (text: string, salt = '') => {
  const blocks = Array.from({ length: EMBEDDING_DIMENSIONS / 32 }, (_, block) => createHash('sha256').update(`${salt}${text}:${block}`).digest());
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, k) => blocks[Math.floor(k / 32)][k % 32] / 255 - 0.5);
};
const ctx = { cursor: null, save: async () => {}, hasBudget: () => true, log: () => {} };
const servers: Server[] = [];

async function product(slug: string, status: 'seeded' | 'verified' | 'banned') {
  await db.insert(products).values({ slug, url: `https://${slug}.example`, name: slug, tagline: `${slug} 소개`, description: `${slug} 설명`,
    category: 'Dev', status, source: 'crawler', verifyToken: `nmv_verify_${slug}`, editTokenHash: 'x'.repeat(64) });
}
async function serving(reply: (text: string) => number[] | null) {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      const { input } = JSON.parse(body) as { input: string[] };
      seen.push(...input);
      const vectors = input.map(reply);
      if (vectors.some(vector => vector === null)) { response.statusCode = 500; response.end('{}'); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
function cli(args: string[]) {
  // 자식은 최소 env 만 — 운영 env 처럼 비상 기록이 비어 있고(degraded), 기본 EMBEDDING_URL 은 닫힌 로컬 포트다
  const env = { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LOG_LEVEL: 'error',
    DATABASE_URL: TEST_DATABASE_URL, DB_POOLER_MODE: 'direct', DB_STATEMENT_TIMEOUT_MS: '5000', DB_LOCK_TIMEOUT_MS: '2000',
    EMBEDDING_URL: 'http://127.0.0.1:9', EMBEDDING_SERVING_PROFILE: '' };
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/embedding-parity.ts', ...args], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }));
}
const snapshot = async () => [...await db.execute(sql`SELECT (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]') FROM products p) AS products,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id', e.product_id, 'model', e.model, 'hash', e.text_hash, 'vector', e.embedding::text, 'at', e.embedded_at) ORDER BY e.product_id), '[]')
     FROM product_embeddings e) AS embeddings`)][0];

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  // 지금 글과 같은 저장 벡터 34건 + 표본이 되면 안 되는 것(비공개·글이 바뀐 것·다른 모델)
  for (let index = 1; index <= 34; index++) await product(`parity-${String(index).padStart(2, '0')}`, index % 2 ? 'seeded' : 'verified');
  await product('parity-banned', 'banned');
  await product('parity-edited', 'seeded');
  await product('parity-old-model', 'seeded');
  await refreshProductEmbeddings(ctx, { embed: async texts => texts.map(text => vectorOf(text)) });
  await db.execute(sql`INSERT INTO product_embeddings(product_id, model, text_hash, embedding, embedded_at)
    SELECT id, ${EMBEDDING_MODEL}, md5(${'x'}), ${`[${vectorOf('banned').join(',')}]`}::halfvec, now() FROM products WHERE slug='parity-banned'`);
  await db.update(products).set({ tagline: '바뀐 소개' }).where(eq(products.slug, 'parity-edited'));
  await db.update(productEmbeddings).set({ model: 'previous-model' }).where(sql`product_id = (SELECT id FROM products WHERE slug='parity-old-model')`);
});
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });

it('dry-run (default) counts only current public vectors and never calls the serving', async () => {
  const fake = await serving(text => vectorOf(text));
  const before = await snapshot();
  const result = await cli([`--url=${fake.url}`]);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ mode: 'dry_run', model: EMBEDDING_MODEL, origin: fake.url, requested: 32, eligible: 34, samples: 32 });
  expect(fake.seen).toEqual([]);
  expect(await snapshot()).toEqual(before);
}, 40_000);

it('execute: the same space gives min cosine ~1 and a semantic profile; the database is unchanged', async () => {
  const fake = await serving(text => vectorOf(text));
  const before = await snapshot();
  const result = await cli([`--url=${fake.url}`, '--samples=40', '--execute']);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({ mode: 'execute', requested: 40, eligible: 34, samples: 34, readiness: { mode: 'semantic' },
    profile: { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, preprocessingHash: EMBEDDING_PREPROCESSING_HASH, parity: { samples: 34 } },
    thresholds: { samples: 32, minCosine: 0.999 } });
  // halfvec 반올림만 남는다
  expect(output.minCosine).toBeGreaterThan(0.9999);
  expect(new Set(fake.seen).size).toBe(34);
  expect(fake.seen.some(text => /parity-(banned|edited|old-model)/.test(text))).toBe(false);
  expect(await snapshot()).toEqual(before);
}, 40_000);

it('execute: a serving in a different space for one sample is degraded(parity_unverified) with exit 2; a failing serving exits 1', async () => {
  const drift = await serving(text => vectorOf(text, text.startsWith('parity-07') ? 'other-pooling' : ''));
  const before = await snapshot();
  const result = await cli([`--url=${drift.url}`, '--samples=34', '--execute']);
  expect(result.code).toBe(2);
  const output = JSON.parse(result.stdout);
  expect(output.minCosine).toBeLessThan(0.999);
  expect(output.readiness).toEqual({ mode: 'degraded', reasons: ['parity_unverified'] });
  const broken = await serving(() => null);
  const failed = await cli([`--url=${broken.url}`, '--execute']);
  expect(failed).toMatchObject({ code: 1, stdout: '' });
  expect(failed.stderr.trim()).toBe('embedding parity failed: http_500');
  expect(await snapshot()).toEqual(before);
}, 40_000);
