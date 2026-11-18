import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EMBEDDING_MODEL, embedTexts } from "../../lib/domain/products/embedding";
import { rerankDocuments } from "../../lib/domain/products/hybrid-search";

const EMBEDDING_URL = "http://100.92.77.66:18081";
const RERANK_URL = "http://100.92.77.66:18082";
const RERANK_MODEL = "bge-reranker-v2-m3-f16@5df93be1";
const PROBE_QUERY = "open source note taking app";
const GAP_MS = 300;
const HEALTH_LIMIT_MS = 300;
const HEALTH_PAUSE_MS = 60_000;
export const MAX_MODEL_BATCH = 32;

type RequestKind = "product" | "parity" | "query" | "rerank" | "probe";
type Timing = { kind: RequestKind; bucket?: string; count: number; ms: number; time: string };
type QueryResult = { vector: number[]; ms: number };
type RerankResult = { scores: number[]; ms: number };

export function hashModelInput(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function createSearchModelClient({ scratch }: { scratch: string }) {
  const cacheDir = join(scratch, "model-responses");
  const timingPath = join(scratch, "model-timings.jsonl");
  const retryPath = join(scratch, "m3-retry-at");
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const lockPath = join(scratch, "m3-model.lock");
  const lock = openSync(lockPath, "wx", 0o600);
  writeFileSync(lock, String(process.pid));

  let queue = Promise.resolve();
  let nextRequest = 0;
  let retryAt = existsSync(retryPath) ? Number(readFileSync(retryPath, "utf8")) : 0;
  const log = existsSync(timingPath) ? readFileSync(timingPath, "utf8").trim() : "";
  let batches = 0;
  for (const line of log ? log.split("\n") : []) {
    const { kind } = JSON.parse(line) as Timing;
    if (kind === "probe") batches = 0;
    if (kind === "product" || kind === "rerank") batches++;
  }
  let closed = false;
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("Model client is closed"));
    const request = queue.then(action);
    queue = request.then(() => undefined, () => undefined);
    return request;
  }

  async function measure<T>(kind: RequestKind, count: number, action: () => Promise<T>, bucket?: string) {
    while (Date.now() < retryAt) await sleep(Math.min(60_000, retryAt - Date.now()));
    while (performance.now() < nextRequest) await sleep(Math.ceil(nextRequest - performance.now()));
    const start = performance.now();
    try {
      const value = await action();
      const ms = performance.now() - start;
      const entry: Timing = { kind, bucket, count, ms, time: new Date().toISOString() };
      appendFileSync(timingPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
      return { value, ms };
    } finally {
      nextRequest = performance.now() + GAP_MS;
    }
  }

  const noRedirect: typeof fetch = async (input, init) => {
    const response = await fetch(input, { ...init, redirect: "error" });
    const retryAfter = response.headers.get("Retry-After");
    if (!response.ok && retryAfter) {
      const retryTime = /^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1_000 : Date.parse(retryAfter);
      if (Number.isFinite(retryTime) && retryTime > retryAt) {
        retryAt = retryTime;
        writeFileSync(retryPath, String(retryAt), { mode: 0o600 });
      }
    }
    return response;
  };

  function embed(texts: readonly string[], kind: RequestKind, bucket?: string) {
    return measure(kind, texts.length, () => embedTexts(texts, {
      url: EMBEDDING_URL, timeoutMs: 30_000, fetchImpl: noRedirect,
    }), bucket);
  }

  async function probe() {
    let result = await embed([PROBE_QUERY], "probe");
    while (result.ms > HEALTH_LIMIT_MS) {
      console.log(`M3 latency probe ${result.ms.toFixed(0)} ms; pausing 60 s`);
      await sleep(HEALTH_PAUSE_MS);
      result = await embed([PROBE_QUERY], "probe");
    }
  }

  async function beforeBatch() {
    if (batches >= 50) {
      await probe();
      batches = 0;
    }
  }

  function cache<T>(model: string, payload: unknown, action: () => Promise<T>): Promise<T> {
    return serialize(async () => {
      const key = hashModelInput(JSON.stringify([model, payload]));
      const path = join(cacheDir, key + ".json");
      if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T;
      const result = await action();
      const temporary = path + ".partial";
      writeFileSync(temporary, JSON.stringify(result), { mode: 0o600 });
      renameSync(temporary, path);
      return result;
    });
  }

  return {
    parity(texts: readonly string[]) {
      if (texts.length !== MAX_MODEL_BATCH) throw new Error("Expected 32 document samples for parity");
      return cache<number[][][]>(EMBEDDING_MODEL, ["parity", texts], async () => {
        await probe();
        const first = await embed(texts, "parity");
        const second = await embed(texts, "parity");
        return [first.value, second.value];
      });
    },
    embedBatch(texts: readonly string[], bucket: string) {
      if (texts.length === 0 || texts.length > MAX_MODEL_BATCH) throw new Error("Embedding batch must contain 1–32 texts");
      return serialize(async () => {
        await beforeBatch();
        const result = await embed(texts, "product", bucket);
        batches++;
        return result.value;
      });
    },
    checkpoint: () => serialize(beforeBatch),
    embedQuery(text: string): Promise<QueryResult> {
      return cache(EMBEDDING_MODEL, ["query", text], async () => {
        const result = await embed([text], "query");
        return { vector: result.value[0], ms: result.ms };
      });
    },
    rerank(query: string, documents: readonly string[]): Promise<RerankResult> {
      if (documents.length === 0 || documents.length > MAX_MODEL_BATCH) throw new Error("Rerank batch must contain 1–32 documents");
      return cache(RERANK_MODEL, ["rerank", query, documents], async () => {
        await beforeBatch();
        const result = await measure("rerank", documents.length, () => rerankDocuments(query, documents, {
          url: RERANK_URL, timeoutMs: 30_000, fetchImpl: noRedirect,
        }));
        batches++;
        return { scores: result.value, ms: result.ms };
      });
    },
    probe: () => serialize(probe),
    async close() {
      if (closed) return;
      closed = true;
      await queue;
      closeSync(lock);
      unlinkSync(lockPath);
    },
  };
}
