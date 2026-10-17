/**
 * 임베딩 확인 표본(PR16 설계 6장, PR16b) — 운영자 도구. 지금 글과 같은 저장 벡터(공개 제품, model = EMBEDDING_MODEL,
 * text_hash = md5(지금 글)) N개를 골라 같은 글을 지정한 대체 서버로 다시 임베딩하고, 최소 코사인과 그 값으로 만든
 * EMBEDDING_SERVING_PROFILE 기록이 지금 코드 기준에서 semantic 인지 degraded 인지 출력한다.
 *
 * DB 는 읽기 전용 TX 로만 읽고 아무것도 쓰지 않는다. 기본은 dry-run(표본만 세고 서버를 부르지 않음)이고 --execute 일 때만 서버를 부른다.
 * 모델 파일 sha256 은 이 도구가 확인하지 못한다 — 운영자가 서버의 GGUF 를 sha256sum 으로 EMBEDDING_MODEL_SHA256 과 맞춘 뒤에만 기록을 쓴다.
 *
 *   tsx scripts/embedding-parity.ts --url=http://127.0.0.1:18081 [--samples=32]             (표본만 센다)
 *   tsx scripts/embedding-parity.ts --url=http://127.0.0.1:18081 [--samples=32] --execute   (다시 임베딩해 잰다)
 *
 * 끝 코드: 0 = dry-run 또는 semantic, 2 = degraded, 1 = 인자·DB·서버 오류.
 */
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { productEmbeddings, products } from '@/lib/db/schema';
import { EMBEDDING_DIMENSIONS, EMBEDDING_DOCUMENT, EMBEDDING_MODEL, EMBEDDING_MODEL_SHA256, EMBEDDING_PARITY_MIN_COSINE,
  EMBEDDING_PARITY_MIN_SAMPLES, EMBEDDING_PREPROCESSING_HASH, embeddingParity, embeddingReadiness, embedTexts, EmbeddingUnavailableError } from '@/lib/domain/products/embedding';

/** 한 번에 보내는 글 수·한 묶음 시간 — product-embedding 잡과 같은 값이다(lib/jobs/products/embedding-refresh.ts) */
const BATCH = 64;
const CALL_MS = 30_000;
const USAGE = 'Usage: embedding-parity.ts --url=http(s)://host[:port] [--samples=1..1000] [--execute]';

export function parseEmbeddingParityArgs(args: string[]): { url: string; samples: number; execute: boolean } {
  try {
    const { values } = parseArgs({ args, strict: true, allowPositionals: false,
      options: { url: { type: 'string' }, samples: { type: 'string' }, execute: { type: 'boolean', default: false } } });
    const url = new URL(values.url ?? '');
    const samples = values.samples === undefined ? EMBEDDING_PARITY_MIN_SAMPLES : Number(values.samples);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !Number.isSafeInteger(samples) || samples < 1 || samples > 1_000) throw new Error();
    return { url: url.href.replace(/\/+$/, ''), samples, execute: values.execute };
  } catch { throw new Error(USAGE); }
}

export type StoredSample = { id: number; text: string; stored: number[] };

/** 지금 글과 같은 저장 벡터에서 무작위 표본. 읽기 전용 TX — DB 가 쓰기를 거절한다 */
export async function sampleStoredEmbeddings(limit: number): Promise<{ eligible: number; samples: StoredSample[] }> {
  return onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const current = and(inArray(products.status, ['seeded', 'verified']), eq(productEmbeddings.model, EMBEDDING_MODEL),
      sql`${productEmbeddings.textHash} = md5(${EMBEDDING_DOCUMENT})`);
    const [{ eligible }] = await tx.select({ eligible: sql<number>`count(*)::int` }).from(products)
      .innerJoin(productEmbeddings, eq(productEmbeddings.productId, products.id)).where(current);
    const rows = await tx.select({ id: products.id, text: EMBEDDING_DOCUMENT, embedding: sql<string>`${productEmbeddings.embedding}::text` })
      .from(products).innerJoin(productEmbeddings, eq(productEmbeddings.productId, products.id)).where(current).orderBy(sql`random()`).limit(limit);
    return { eligible: Number(eligible), samples: rows.map(row => ({ id: row.id, text: row.text, stored: JSON.parse(row.embedding) as number[] })) };
  }));
}

/**
 * 표본의 글을 지정 서버로 다시 임베딩해(기존 embedTexts 요청·응답 검증 그대로) 저장 벡터와의 최소 코사인을 잰다.
 * 기록은 지금 코드 기준값 + 잰 parity 다. readiness 는 그 기록을 embeddingReadiness 에 넣은 결과다.
 */
export async function measureEmbeddingParity(samples: readonly StoredSample[], options: { url: string; timeoutMs: number }) {
  const pairs: { observed: number[]; stored: number[] }[] = [];
  for (let start = 0; start < samples.length; start += BATCH) {
    const chunk = samples.slice(start, start + BATCH);
    const vectors = await embedTexts(chunk.map(sample => sample.text), { url: options.url, timeoutMs: options.timeoutMs });
    chunk.forEach((sample, index) => pairs.push({ observed: vectors[index], stored: sample.stored }));
  }
  const parity = embeddingParity(pairs);
  const profile = { version: 1 as const, model: EMBEDDING_MODEL, modelSha256: EMBEDDING_MODEL_SHA256, dimensions: EMBEDDING_DIMENSIONS,
    preprocessingHash: EMBEDDING_PREPROCESSING_HASH, parity };
  return { ...parity, profile, readiness: embeddingReadiness({ EMBEDDING_SERVING_PROFILE: JSON.stringify(profile) }, options.url) };
}

async function main() {
  try {
    const options = parseEmbeddingParityArgs(process.argv.slice(2));
    const { eligible, samples } = await sampleStoredEmbeddings(options.samples);
    const base = { model: EMBEDDING_MODEL, origin: new URL(options.url).origin, requested: options.samples, eligible, samples: samples.length };
    if (!options.execute) {
      console.log(JSON.stringify({ mode: 'dry_run', ...base }));
      return;
    }
    // 이 측정은 그 기록을 만들기 위한 것이라 이 프로세스 안에서만 기존 기록 검사 없이 지정 서버를 부른다(읽기만, 쓰기 0)
    delete process.env.EMBEDDING_SERVING_PROFILE;
    const result = await measureEmbeddingParity(samples, { url: options.url, timeoutMs: CALL_MS });
    console.log(JSON.stringify({ mode: 'execute', ...base, minCosine: result.minCosine, readiness: result.readiness, profile: result.profile,
      thresholds: { samples: EMBEDDING_PARITY_MIN_SAMPLES, minCosine: EMBEDDING_PARITY_MIN_COSINE } }));
    process.exitCode = result.readiness.mode === 'semantic' ? 0 : 2;
  } catch (error) {
    const message = error instanceof Error && error.message === USAGE ? USAGE
      : `embedding parity failed: ${error instanceof EmbeddingUnavailableError ? error.message : 'check database/url configuration'}`;
    console.error(message);
    process.exitCode = 1;
  } finally {
    const client = (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient;
    await client?.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && /^embedding-parity\.[cm]?[jt]s$/.test(basename(process.argv[1]))) void main();
