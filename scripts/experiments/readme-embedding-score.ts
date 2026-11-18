/**
 * Offline README experiment. Build a source-blind pool, then score frozen
 * rankings against the original judgments and the common expanded judgments.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { JUDGED, ndcg } from "../search-judged-fixtures";
import { readExperimentCost } from "./readme-embedding-cost";

const gradeSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const qrelsSchema = z.record(z.string(), z.record(z.string(), gradeSchema));
type Qrels = z.infer<typeof qrelsSchema>;

const rankingSchema = z.object({
  query: z.string(),
  slug: z.string(),
  slugs: z.array(z.string()),
  hits: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
  translated: z.string().nullable(),
});
const runSchema = z.object({
  variant: z.enum(["V0", "V1", "V1raw", "V2@0.3", "V2@0.5", "V2@1.0"]),
  translation: z.enum(["cache", "none"]),
  stage: z.enum(["rrf", "reranked"]),
  queries: z.array(rankingSchema).length(JUDGED.length),
});
const rankingsSchema = z.object({ runs: z.array(runSchema).min(1) });
type Run = z.infer<typeof runSchema>;

const pairSchema = z.object({ id: z.string(), query: z.string(), slug: z.string() });
type Pair = z.infer<typeof pairSchema>;
const keySchema = z.object({ pairs: z.array(pairSchema) });
const labelsSchema = z.object({
  judgments: z.array(z.object({ id: z.string(), grade: gradeSchema, reason: z.string().optional() })),
});

const TOP = 10;
const REFERENCE_DEPTH = 20;
const README_EXCERPT_CHARS = 1000;
const BOOTSTRAP_TRIALS = 10_000;
const BOOTSTRAP_SEED = 20261118;
const SCORE_TOLERANCE = 1e-12;

function readJson(filename: string): unknown {
  return JSON.parse(readFileSync(filename, "utf8"));
}

function writeJson(filename: string, data: unknown) {
  writeFileSync(filename, JSON.stringify(data, null, 2) + "\n");
}

function loadRuns(filename: string): Run[] {
  const { runs } = rankingsSchema.parse(readJson(filename));
  const seen = new Set<string>();
  for (const run of runs) {
    const key = `${run.stage}/${run.translation}/${run.variant}`;
    if (seen.has(key)) throw new Error(`Duplicate run ${key}`);
    seen.add(key);

    const byQuery = new Map(run.queries.map((row) => [row.query, row]));
    run.queries = JUDGED.map(([query, slug]) => {
      const row = byQuery.get(query);
      if (row?.slug !== slug) throw new Error(`Missing or mismatched reference for ${key} and ${query}`);
      if (new Set(row.slugs).size !== row.slugs.length) throw new Error(`Duplicate ranked slug for ${key} and ${query}`);
      return row;
    });
  }
  for (const run of runs) {
    if (!seen.has(`${run.stage}/${run.translation}/V0`)) {
      throw new Error(`Missing V0 for ${run.stage}/${run.translation}`);
    }
  }
  return runs;
}

function loadOriginal(): Qrels {
  const qrels = qrelsSchema.parse(readJson(path.join(__dirname, "../search-judgments.json")));
  for (const [query, slug] of JUDGED) {
    if (!Object.hasOwn(qrels[query] ?? {}, slug)) {
      throw new Error(`Missing original reference judgment for ${query} / ${slug}`);
    }
  }
  return qrels;
}

function unjudgedPairs(runs: Run[], qrels: Qrels): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const { queries } of runs) {
    for (const { query, slugs } of queries) {
      for (const slug of slugs.slice(0, TOP)) {
        if (Object.hasOwn(qrels[query], slug)) continue;
        const id = createHash("sha256").update(JSON.stringify(["20261118", query, slug])).digest("hex").slice(0, 20);
        const previous = pairs.get(id);
        if (previous && (previous.query !== query || previous.slug !== slug)) throw new Error(`Pool ID collision ${id}`);
        pairs.set(id, { id, query, slug });
      }
    }
  }
  // Hash ordering deterministically mixes queries, variants, and positions.
  return [...pairs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

type ProductText = { name: string; tagline: string; description: string; readme: string };

function readProductText(snapshot: string, pairs: Pair[]): Map<string, ProductText> {
  const remaining = new Set(pairs.map(({ slug }) => slug));
  const products = new Map<string, ProductText>();
  const files = readdirSync(snapshot).filter((name) => /^products_\d+\.json$/.test(name)).sort();
  if (!files.length) throw new Error(`Snapshot has no product files at ${snapshot}`);
  for (const name of files) {
    if (!remaining.size) break;
    const rows = readJson(path.join(snapshot, name)) as Array<{ r: {
      slug: string;
      name: string;
      tagline: string | null;
      description: string | null;
      search_readme: string | null;
    } }>;
    for (const { r: row } of rows) {
      if (!remaining.delete(row.slug)) continue;
      products.set(row.slug, {
        name: row.name,
        tagline: row.tagline ?? "",
        description: row.description ?? "",
        readme: [...(row.search_readme ?? "")].slice(0, README_EXCERPT_CHARS).join(""),
      });
    }
  }
  if (remaining.size) throw new Error(`${remaining.size} pool products missing from snapshot: ${[...remaining].slice(0, 8).join(", ")}`);
  return products;
}

function expandQrels(original: Qrels, pairs: Pair[], keyFile: string, labelsFiles: string[]): Qrels {
  const { pairs: recorded } = keySchema.parse(readJson(keyFile));
  if (recorded.length !== pairs.length || recorded.some((pair, index) => {
    const expected = pairs[index];
    return pair.id !== expected.id || pair.query !== expected.query || pair.slug !== expected.slug;
  })) throw new Error("Pool key differs from the current rankings. Use the key from the rankings being scored.");

  const allowed = new Map(pairs.map((pair) => [pair.id, pair]));
  const seen = new Set<string>();
  const expanded = structuredClone(original);
  for (const file of labelsFiles) {
    const { judgments } = labelsSchema.parse(readJson(file));
    for (const { id, grade } of judgments) {
      const pair = allowed.get(id);
      if (!pair) throw new Error(`Unknown pool ID ${id}`);
      if (seen.has(id)) throw new Error(`Duplicate judgment for ${id}`);
      seen.add(id);
      expanded[pair.query] = { ...expanded[pair.query], [pair.slug]: grade };
    }
  }
  if (seen.size !== allowed.size) {
    const examples = [...allowed.keys()].filter((id) => !seen.has(id)).slice(0, 8);
    throw new Error(`Missing ${allowed.size - seen.size} blind judgments. Examples: ${examples.join(", ")}`);
  }
  return expanded;
}

function percentile(sorted: number[], proportion: number) {
  return sorted[Math.floor(sorted.length * proportion)];
}

function evaluateRun(run: Run, qrels: Qrels) {
  const results = run.queries.map(({ query, slug, slugs, hits, ms, translated }) => {
    const grades = qrels[query];
    const gradeOf = (candidate: string) => Object.hasOwn(grades, candidate) ? grades[candidate] : null;
    const index = slugs.indexOf(slug);
    const deepRank = index < 0 ? null : index + 1;
    return {
      query, slug, hits, ms, translated, deepRank,
      rank: deepRank !== null && deepRank <= REFERENCE_DEPTH ? deepRank : null,
      ndcg10: ndcg(slugs.slice(0, TOP).map((candidate) => gradeOf(candidate) ?? 0), Object.values(grades), TOP),
      relevantTop5: slugs.slice(0, 5).filter((candidate) => (gradeOf(candidate) ?? 0) >= 1).length,
      top1Grade: slugs.length ? gradeOf(slugs[0]) : null,
      unjudgedTop10: slugs.slice(0, TOP).filter((candidate) => gradeOf(candidate) === null).length,
      retrievedTop10: Math.min(TOP, slugs.length),
    };
  });
  const n = results.length;
  const within = (k: number) => results.filter(({ rank }) => rank !== null && rank <= k).length;
  const sum = (pick: (row: (typeof results)[number]) => number) => results.reduce((total, row) => total + pick(row), 0);
  const ms = results.map((row) => row.ms).sort((a, b) => a - b);
  const hits = results.map((row) => row.hits).sort((a, b) => a - b);
  const zero = results.filter((row) => row.hits === 0).length;
  const summary = {
    queries: n,
    top1: within(1), top5: within(5), top10: within(10), top20: within(20),
    mrr: sum(({ rank }) => rank ? 1 / rank : 0) / n,
    zero,
    zeroRate: zero / n,
    medianHits: percentile(hits, 0.5),
    p50Ms: percentile(ms, 0.5),
    p95Ms: percentile(ms, 0.95),
    outside20InPool: results.filter(({ rank, deepRank }) => rank === null && deepRank !== null).length,
    notMatched: results.filter(({ deepRank }) => deepRank === null).length,
    graded: n,
    ndcg10: sum((row) => row.ndcg10) / n,
    relevantTop5: sum((row) => row.relevantTop5) / (5 * n),
    top1Relevant: results.filter(({ top1Grade }) => (top1Grade ?? 0) >= 1).length,
    top1Exact: results.filter(({ top1Grade }) => top1Grade === 2).length,
    unjudgedTop10: sum((row) => row.unjudgedTop10),
    retrievedTop10: sum((row) => row.retrievedTop10),
  };
  return { variant: run.variant, translation: run.translation, stage: run.stage, summary, results };
}

/** Mulberry32. Reset per comparison so every pair uses the same query draws. */
function bootstrapMean(differences: number[]): [number, number] {
  let state = BOOTSTRAP_SEED;
  function random() {
    state = (state + 0x6d2b79f5) | 0;
    let bits = Math.imul(state ^ (state >>> 15), state | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
  }
  const means = Array.from({ length: BOOTSTRAP_TRIALS }, () => {
    let sum = 0;
    for (let draw = 0; draw < differences.length; draw++) {
      sum += differences[Math.floor(random() * differences.length)];
    }
    return sum / differences.length;
  }).sort((a, b) => a - b);
  return [percentile(means, 0.025), percentile(means, 0.975)];
}

function evaluate(runs: Run[], qrels: Qrels) {
  const scored = runs.map((run) => evaluateRun(run, qrels));
  return scored.map((run) => {
    const baseline = scored.find(({ variant, translation, stage }) =>
      variant === "V0" && translation === run.translation && stage === run.stage)!;
    const byQuery = run.results.map(({ query, ndcg10 }, index) => {
      const v0 = baseline.results[index].ndcg10;
      const delta = ndcg10 - v0;
      return { query, v0, ndcg10, delta: Math.abs(delta) <= SCORE_TOLERANCE ? 0 : delta };
    });
    const best = byQuery.filter(({ delta }) => delta > 0).sort((a, b) => b.delta - a.delta);
    const worst = byQuery.filter(({ delta }) => delta < 0).sort((a, b) => a.delta - b.delta);
    const deltaVsV0 = run.variant === "V0" ? null : {
      mean: byQuery.reduce((sum, row) => sum + row.delta, 0) / byQuery.length,
      ci95: bootstrapMean(byQuery.map(({ delta }) => delta)),
      improved: best.length,
      worse: worst.length,
      tied: byQuery.length - best.length - worst.length,
      best: best.slice(0, 5),
      worst: worst.slice(0, 5),
      byQuery,
    };
    return { ...run, deltaVsV0 };
  });
}

type Report = {
  poolSize: number;
  bootstrap: { trials: number; seed: number };
  cost?: ReturnType<typeof readExperimentCost>;
  original: ReturnType<typeof evaluate>;
  expanded: ReturnType<typeof evaluate> | null;
};

function formatDelta(delta: number) {
  return `${delta > 0 ? "+" : ""}${delta.toFixed(3)}`;
}

function renderMarkdown(report: Report): string {
  const sections = [
    "# README 임베딩 오프라인 평가",
    "",
    `기존 정답 ${JUDGED.length}개 질의에서 상위 10의 미채점 후보를 모았습니다. 중복 제거 후 ${report.poolSize}쌍입니다.`,
    "",
    `V0 대비 95% 구간은 같은 질의를 단위로 비교한 ${report.bootstrap.trials.toLocaleString("ko-KR")}회 부트스트랩 결과입니다. 여러 안을 60개 질의로 비교했으므로 ±0.02 안팎의 차이는 잡음일 수 있습니다.`,
  ];
  for (const [title, runs] of [["기존 채점", report.original], ["추가 채점 포함", report.expanded]] as const) {
    if (!runs) continue;
    sections.push(
      "", `## ${title}`, "",
      "| 안 | 번역 | 단계 | 1위 | 5위 내 | MRR | nDCG@10 | V0 대비 [95% 구간] | 개선/하락/동률 | 상위 5 적합 | 0건 비율 | p50/p95 ms | 미채점/상위 10 |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const { variant, translation, stage, summary: row, deltaVsV0: delta } of runs) {
      const comparison = delta ? `${formatDelta(delta.mean)} [${delta.ci95.map(formatDelta).join(", ")}]` : "—";
      const directions = delta ? `${delta.improved}/${delta.worse}/${delta.tied}` : "—";
      sections.push(`| ${variant} | ${translation} | ${stage} | ${row.top1}/${row.queries} | ${row.top5}/${row.queries} | ${row.mrr.toFixed(3)} | ${row.ndcg10.toFixed(3)} | ${comparison} | ${directions} | ${(row.relevantTop5 * 100).toFixed(1)}% | ${(row.zeroRate * 100).toFixed(1)}% | ${row.p50Ms.toFixed(1)}/${row.p95Ms.toFixed(1)} | ${row.unjudgedTop10}/${row.retrievedTop10} |`);
    }
  }
  if (report.cost) {
    sections.push(
      "", "## 벡터 생성 시간과 저장 공간", "",
      "실측 요청 시간에 묶음당 300ms를 더한 문서당 시간으로 환산했습니다. DB 적재와 지연 프로브에 따른 대기는 표의 시간에서 제외했습니다. V2의 전체 재생성 시간은 V0을 포함합니다. PostgreSQL 크기는 해당 벡터 테이블의 기본 키와 TOAST를 포함합니다.",
      "",
      "| 벡터 | 실제 새 문서 | 묶음 수 | 요청 p50/p95 ms | 전체 재생성 시간 | V0 보유 시 추가 시간 | halfvec 데이터 MiB | PostgreSQL 테이블 MiB |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    const mib = (bytes: number) => (bytes / 2 ** 20).toFixed(1);
    for (const row of report.cost.variants) {
      sections.push(`| ${row.bucket} | ${row.embedded} | ${row.batches} | ${row.p50Ms?.toFixed(0)}/${row.p95Ms?.toFixed(0)} | ${row.coldRebuildHours.toFixed(2)}h | ${row.extraFromExistingV0Hours.toFixed(2)}h | ${mib(row.payloadBytes)} | ${mib(row.postgresTotalBytes)} |`);
    }
  }
  if (report.expanded) {
    sections.push(
      "", "## 질의별 nDCG@10 변화", "",
      "| 안 | 번역 | 단계 | 가장 개선된 질의 | 가장 하락한 질의 |",
      "| --- | --- | --- | --- | --- |",
    );
    const changes = (rows: { query: string; delta: number }[]) =>
      rows.slice(0, 3).map(({ query, delta }) => `${query.replaceAll("|", "\\|")} (${formatDelta(delta)})`).join(", ") || "—";
    for (const { variant, translation, stage, deltaVsV0: delta } of report.expanded) {
      if (delta) sections.push(`| ${variant} | ${translation} | ${stage} | ${changes(delta.best)} | ${changes(delta.worst)} |`);
    }
  }
  return sections.join("\n") + "\n";
}

function main() {
  const [mode, ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, options: {
    rankings: { type: "string" },
    snapshot: { type: "string" },
    out: { type: "string" },
    key: { type: "string" },
    labels: { type: "string", multiple: true },
    markdown: { type: "string" },
    scratch: { type: "string" },
    "original-only": { type: "boolean" },
  } });
  const { rankings, snapshot, out, key, labels, markdown } = values;
  if (!rankings || !out || (mode !== "pool" && mode !== "score")) {
    throw new Error("Use pool --rankings=FILE --snapshot=DATA_DIR --out=FILE --key=FILE or score --rankings=FILE --out=FILE --key=FILE --labels=FILE [--markdown=FILE].");
  }
  const runs = loadRuns(rankings);
  const original = loadOriginal();
  const pairs = unjudgedPairs(runs, original);
  if (mode === "pool") {
    if (!snapshot || !key || path.resolve(key) === path.resolve(out)) {
      throw new Error("Provide --snapshot and separate --out and --key files for blind grading.");
    }
    const products = readProductText(snapshot, pairs);
    writeJson(out, pairs.map(({ id, query, slug }) => ({ id, query, ...products.get(slug)! })));
    writeJson(key, { pairs });
    console.log(`Created blind grading pool with ${pairs.length} pairs.`);
    return;
  }
  if (!values["original-only"] && (!key || !labels?.length)) {
    throw new Error("Provide --key and --labels for the full score, or pass --original-only for interim results.");
  }
  const expanded = values["original-only"] ? null : expandQrels(original, pairs, key!, labels!);
  const report: Report = {
    poolSize: pairs.length,
    bootstrap: { trials: BOOTSTRAP_TRIALS, seed: BOOTSTRAP_SEED },
    cost: values.scratch ? readExperimentCost(values.scratch) : undefined,
    original: evaluate(runs, original),
    expanded: expanded ? evaluate(runs, expanded) : null,
  };
  writeJson(out, report);
  if (markdown) writeFileSync(markdown, renderMarkdown(report));
  console.log(`Scored ${runs.length} runs, ${JUDGED.length} queries per run, ${expanded ? pairs.length : 0} added judgments.`);
}

main();
