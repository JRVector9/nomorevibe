/**
 * 4개 언어 검색 실험의 M3 임베딩·재정렬 호출 — 한 번에 하나, 300ms 간격, 응답은 파일 캐시.
 *
 * M3 검색 모델 서버는 운영 웹 검색과 같은 GPU 를 쓴다. 그래서:
 *  - 동시에 하나만 부르고, 부른 뒤 300ms 쉰다.
 *  - 50번마다 검색어 하나를 임베딩해 보고 300ms 를 넘으면 60초 쉰다(운영이 붐빈다는 뜻).
 *  - Retry-After 를 받으면 그때까지 기다린다.
 *  - 같은 입력은 캐시에서 읽어 다시 부르지 않는다(다시 돌려도 M3 를 부르지 않는다).
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EMBEDDING_MODEL, embedTexts } from "../../lib/domain/products/embedding";
import { rerankDocuments } from "../../lib/domain/products/hybrid-search";

const EMBEDDING_URL = process.env.NMV_ML_EMBEDDING_URL ?? "http://100.92.77.66:18081";
const RERANK_URL = process.env.NMV_ML_RERANK_URL ?? "http://100.92.77.66:18082";
const RERANK_MODEL = "bge-reranker-v2-m3-f16@5df93be1";
const PROBE_QUERY = "open source note taking app";
const GAP_MS = 300;
const HEALTH_LIMIT_MS = 300;
const HEALTH_PAUSE_MS = 60_000;
const PROBE_EVERY = 50;

type Kind = "query" | "rerank" | "probe";

export type SearchModels = {
  embedQuery(text: string): Promise<number[]>;
  rerank(query: string, documents: readonly string[]): Promise<number[]>;
  stats(): { calls: number; cached: number; pauses: number };
  close(): Promise<void>;
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export function createSearchModels(scratch: string): SearchModels {
  const cacheDir = join(scratch, "model-cache");
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const timingPath = join(scratch, "model-timings.jsonl");
  const lockPath = join(scratch, "m3-model.lock");
  const lock = openSync(lockPath, "wx", 0o600);
  writeFileSync(lock, String(process.pid));

  let queue: Promise<unknown> = Promise.resolve();
  let nextAt = 0;
  let retryAt = 0;
  let sinceProbe = 0;
  const counts = { calls: 0, cached: 0, pauses: 0 };
  let closed = false;

  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error("model client closed"));
    const run = queue.then(action);
    queue = run.catch(() => undefined);
    return run;
  };

  const fetchWithRetryAfter: typeof fetch = async (input, init) => {
    const response = await fetch(input, { ...init, redirect: "error" });
    const header = response.headers.get("Retry-After");
    if (!response.ok && header) {
      const at = /^\d+$/.test(header) ? Date.now() + Number(header) * 1000 : Date.parse(header);
      if (Number.isFinite(at)) retryAt = Math.max(retryAt, at);
    }
    return response;
  };

  async function call<T>(kind: Kind, count: number, action: () => Promise<T>): Promise<{ value: T; ms: number }> {
    while (Date.now() < retryAt) await sleep(Math.min(60_000, retryAt - Date.now()));
    while (performance.now() < nextAt) await sleep(Math.ceil(nextAt - performance.now()));
    const started = performance.now();
    try {
      const value = await action();
      const ms = performance.now() - started;
      appendFileSync(timingPath, JSON.stringify({ kind, count, ms: Math.round(ms * 10) / 10, time: new Date().toISOString() }) + "\n", { mode: 0o600 });
      counts.calls++;
      return { value, ms };
    } finally {
      nextAt = performance.now() + GAP_MS;
    }
  }

  const embedOne = (text: string) => embedTexts([text], { url: EMBEDDING_URL, timeoutMs: 30_000, fetchImpl: fetchWithRetryAfter });

  async function probeIfDue() {
    if (sinceProbe < PROBE_EVERY) return;
    sinceProbe = 0;
    for (;;) {
      const { ms } = await call("probe", 1, () => embedOne(PROBE_QUERY));
      if (ms <= HEALTH_LIMIT_MS) return;
      counts.pauses++;
      console.log(`M3 probe ${ms.toFixed(0)}ms > ${HEALTH_LIMIT_MS}ms; pausing 60s`);
      await sleep(HEALTH_PAUSE_MS);
    }
  }

  function cached<T>(key: unknown, action: () => Promise<T>): Promise<T> {
    return serialize(async () => {
      const path = join(cacheDir, hash(key) + ".json");
      if (existsSync(path)) {
        counts.cached++;
        return JSON.parse(readFileSync(path, "utf8")) as T;
      }
      await probeIfDue();
      const value = await action();
      sinceProbe++;
      writeFileSync(path + ".partial", JSON.stringify(value), { mode: 0o600 });
      renameSync(path + ".partial", path);
      return value;
    });
  }

  return {
    embedQuery: (text) => cached([EMBEDDING_MODEL, "query", text], async () => (await call("query", 1, () => embedOne(text))).value[0]),
    rerank: (query, documents) => cached([RERANK_MODEL, "rerank", query, documents], async () => (await call("rerank", documents.length,
      () => rerankDocuments(query, documents, { url: RERANK_URL, timeoutMs: 30_000, fetchImpl: fetchWithRetryAfter }))).value),
    stats: () => ({ ...counts }),
    async close() {
      if (closed) return;
      closed = true;
      await queue;
      closeSync(lock);
      unlinkSync(lockPath);
    },
  };
}
