import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_MODEL_SHA256, EMBEDDING_PARITY_MIN_SAMPLES, EMBEDDING_PREPROCESSING_HASH,
  EmbeddingUnavailableError } from '@/lib/domain/products/embedding';
import { measureEmbeddingParity, parseEmbeddingParityArgs } from '@/scripts/embedding-parity';

/**
 * 임베딩 확인 표본 도구(PR16b) — 저장 벡터의 글을 지정 서버로 다시 임베딩해 최소 코사인을 재고 readiness 를 낸다.
 * 서버 호출은 이 시험에서 loopback 가짜 서버로만 한다. 가짜 서버는 받은 글마다 미리 정한 벡터를 돌려준다.
 */
const vector = (seed: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, k) => Math.sin(seed * 31 + k) + (k % 7) / 10);
const samples = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1, text: `제품 ${i + 1}\n소개`, stored: vector(i + 1) }));
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });

/** 받은 글 → 돌려줄 벡터. 요청 수와 받은 글을 기록한다 */
async function fakeServing(reply: (text: string) => number[]) {
  const seen: string[][] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      const { input } = JSON.parse(body) as { input: string[] };
      seen.push(input);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: reply(text) })) }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe('인자', () => {
  it('URL 은 필수이고 표본 수는 1~1000, 서버 호출은 --execute 일 때만이다', () => {
    expect(parseEmbeddingParityArgs(['--url=http://127.0.0.1:18081/'])).toEqual({ url: 'http://127.0.0.1:18081', samples: EMBEDDING_PARITY_MIN_SAMPLES, execute: false });
    expect(parseEmbeddingParityArgs(['--url=https://embed.example/v', '--samples=64', '--execute'])).toEqual({ url: 'https://embed.example/v', samples: 64, execute: true });
    for (const args of [[], ['--samples=32'], ['--url=ftp://x'], ['--url=http://user:pw@x'], ['--url=http://x?a=1'], ['--url=http://x', '--samples=0'],
      ['--url=http://x', '--samples=1001'], ['--url=http://x', '--samples=1.5'], ['--url=http://x', '--apply'], ['--url=http://x', 'extra']]) {
      expect(() => parseEmbeddingParityArgs(args), args.join(' ')).toThrow(/^Usage:/);
    }
  });
});

describe('측정', () => {
  it('같은 벡터를 돌려주는 서버는 최소 코사인 1 로 semantic 기록을 만든다(64건씩 나눠 부른다)', async () => {
    const all = samples(70);
    const byText = new Map(all.map(sample => [sample.text, sample.stored]));
    const serving = await fakeServing(text => byText.get(text)!);
    const result = await measureEmbeddingParity(all, { url: serving.url, timeoutMs: 5_000 });
    expect(serving.seen.map(batch => batch.length)).toEqual([64, 6]);
    expect(serving.seen.flat()).toEqual(all.map(sample => sample.text));
    expect(result.samples).toBe(70);
    expect(result.minCosine).toBeGreaterThan(0.999999);
    expect(result.profile).toEqual({ version: 1, model: EMBEDDING_MODEL, modelSha256: EMBEDDING_MODEL_SHA256, dimensions: EMBEDDING_DIMENSIONS,
      preprocessingHash: EMBEDDING_PREPROCESSING_HASH, parity: { samples: 70, minCosine: result.minCosine } });
    expect(result.readiness).toEqual({ mode: 'semantic' });
  });

  it('한 건이라도 다른 공간(풀링 오류 등)이면 그 최소 코사인으로 degraded(parity_unverified)다', async () => {
    const all = samples(EMBEDDING_PARITY_MIN_SAMPLES);
    const byText = new Map(all.map(sample => [sample.text, sample.stored]));
    const serving = await fakeServing(text => text === all[5].text ? vector(999) : byText.get(text)!);
    const result = await measureEmbeddingParity(all, { url: serving.url, timeoutMs: 5_000 });
    expect(result.minCosine).toBeLessThan(0.999);
    expect(result.readiness).toEqual({ mode: 'degraded', reasons: ['parity_unverified'] });
  });

  it('표본이 기준 수보다 적으면 모두 같아도 확인되지 않은 것이다', async () => {
    const all = samples(EMBEDDING_PARITY_MIN_SAMPLES - 1);
    const byText = new Map(all.map(sample => [sample.text, sample.stored]));
    const serving = await fakeServing(text => byText.get(text)!);
    const result = await measureEmbeddingParity(all, { url: serving.url, timeoutMs: 5_000 });
    expect(result.minCosine).toBeGreaterThan(0.999999);
    expect(result.readiness).toEqual({ mode: 'degraded', reasons: ['parity_unverified'] });
  });

  it('차원이 다른 서버는 측정하지 않고 기존 응답 검증 오류로 멈춘다', async () => {
    const serving = await fakeServing(() => [1, 0, 0]);
    await expect(measureEmbeddingParity(samples(2), { url: serving.url, timeoutMs: 5_000 })).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });
});
