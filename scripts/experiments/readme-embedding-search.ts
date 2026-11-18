import { renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { GLOSSARY_VERSION, QUERY_PROMPT_VERSION, glossaryHints, queryExpansions, queryTranslationPhrases, textHash } from "@/lib/crawl/translate";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { vectorLiteral } from "@/lib/domain/products/embedding";
import { CANDIDATES, MIN_SIMILARITY, RERANK_TOP, RRF_K, fuseRanks } from "@/lib/domain/products/hybrid-search";
import { relevanceWindow } from "@/lib/domain/products/relevance";
import { countProducts, listedByDefault, listProductSlugs, notAuditHeld, notDown, productDocuments } from "@/lib/domain/products/repository";
import { normalizeQuery, planSearch, queryTranslationKey, searchQuerySourceLocale, type ResolvedSearch } from "@/lib/domain/products/search-translation";
import { JUDGED } from "../search-judged-fixtures";
import { openReadmeExperimentDatabase } from "./readme-embedding-db";
import { createSearchModelClient } from "./readme-embedding-model";

const { products, textTranslations } = schema;
const PUBLIC = { statuses: ["verified", "seeded"] as schema.ProductStatus[], excludeDown: true };
const DEPTH = 20;
const DIAGNOSE_DEPTH = 200;
const VECTORS = {
  V0: "readme_exp_v0",
  V1: "readme_exp_v1",
  V1raw: "readme_exp_v1raw",
  README: "readme_exp_v2",
};
type VectorSet = keyof typeof VECTORS;

const VARIANTS = ["V0", "V1", "V1raw", "V2@0.3", "V2@0.5", "V2@1.0"] as const;
type Variant = (typeof VARIANTS)[number];
const README_WEIGHTS = { "V2@0.3": 0.3, "V2@0.5": 0.5, "V2@1.0": 1 };
type Translation = "cache" | "none";
type Stage = "rrf" | "reranked";
type CacheSource = "current" | "legacy" | null;

type Models = {
  embedQuery(text: string): Promise<{ vector: number[]; ms: number }>;
  rerank(query: string, documents: readonly string[]): Promise<{ scores: number[]; ms: number }>;
};

type Timings = {
  translationMs: number;
  embeddingModelMs: number;
  lexicalMs: number;
  semanticMs: number;
  fusionMs: number;
  documentsMs: number;
  rerankModelMs: number;
  windowMs: number;
};

export type RankingQuery = {
  query: string;
  slug: string;
  slugs: string[];
  hits: number;
  ms: number;
  translated: string | null;
  translationPending: boolean;
  cacheSource: CacheSource;
  builtInExpansions: string[];
  reranked: boolean;
  timing: Timings;
};

export type RankingOutput = {
  cohort: { products: number; eligibleProducts: number; vectors: Partial<Record<VectorSet, number>> };
  translationCoverage: { eligible: number; current: number; legacy: number; misses: number; withBuiltInExpansions: number } | null;
  complete: boolean;
  runs: { variant: Variant; translation: Translation; stage: Stage; queries: RankingQuery[] }[];
};

type Options = {
  variants: readonly Variant[];
  translations: readonly Translation[];
  queries: readonly (readonly [string, string])[];
  stages: readonly Stage[];
  outputPath?: string;
  progress?: (done: number, total: number) => void;
};

const observed = (started: number) => performance.now() - started;

async function timed<T>(load: () => T | Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await load();
  return { value, ms: observed(started) };
}

function wantsReadme(variant: Variant): variant is keyof typeof README_WEIGHTS {
  return Object.hasOwn(README_WEIGHTS, variant);
}

/**
 * Korean→English cache key before 9e95dc37. The namespace changed, but the
 * Korean prompt and glossary versions remained the same for these entries.
 */
function compatibleKoreanCacheKey(query: string): string {
  const normalized = normalizeQuery(query);
  const glossary = glossaryHints(normalized) ? `g${GLOSSARY_VERSION}` : "";
  return textHash(`q${QUERY_PROMPT_VERSION}${glossary}:${normalized}`);
}

async function resolveExperimentQuery(query: string, translation: Translation): Promise<ResolvedSearch & {
  cacheSource: CacheSource;
  builtInExpansions: string[];
}> {
  if (translation === "none") return { queries: [query], translated: null, cacheSource: null, builtInExpansions: [] };

  const raw = query.trim();
  const source = searchQuerySourceLocale(raw);
  let stored: string | null = null;
  let cacheSource: CacheSource = null;
  if (source) {
    const currentKey = queryTranslationKey(raw);
    const legacyKey = source === "ko" ? compatibleKoreanCacheKey(raw) : null;
    const rows = await db.select({ hash: textTranslations.sourceHash, text: textTranslations.translated })
      .from(textTranslations).where(and(
        eq(textTranslations.targetLang, "en"),
        eq(textTranslations.status, "done"),
        inArray(textTranslations.sourceHash, legacyKey ? [currentKey, legacyKey] : [currentKey]),
      ));
    const current = rows.find((row) => row.hash === currentKey)?.text;
    const legacy = rows.find((row) => row.hash === legacyKey)?.text;
    stored = current ?? legacy ?? null;
    cacheSource = current != null ? "current" : legacy != null ? "legacy" : null;
  }
  const builtInExpansions = source === "ko" ? queryExpansions(raw) : [];
  const phrases = [...new Set([...(stored ? queryTranslationPhrases(stored) : []), ...builtInExpansions])];
  const texts = [raw, ...phrases];
  return {
    queries: { ...await planSearch(texts), groups: texts.map((_, index) => index === 0 ? 0 : 1) },
    translated: phrases.length ? phrases.join(" / ") : null,
    translationPending: source !== null && stored === null,
    cacheSource,
    builtInExpansions,
  };
}

function fuse(lexical: string[], semantic: string[], readme?: { slugs: string[]; weight: number }): string[] {
  if (!readme || readme.weight === 1) return fuseRanks(readme ? [lexical, semantic, readme.slugs] : [lexical, semantic]);
  const scores = new Map<string, number>();
  for (const [slugs, weight] of [[lexical, 1], [semantic, 1], [readme.slugs, readme.weight]] as const) {
    slugs.forEach((slug, index) => scores.set(slug, (scores.get(slug) ?? 0) + weight / (RRF_K + index + 1)));
  }
  return [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!);
}

/** Same halfvec scan, minimum cosine and slug tiebreak as nearestProductSlugs. */
async function nearestSlugs(vector: readonly number[], set: VectorSet): Promise<string[]> {
  const distance = sql`(v.embedding <=> ${vectorLiteral(vector)}::halfvec)`;
  const rows = await db.execute<{ slug: string }>(sql`
    select ${products.slug} from ${products}
    join ${sql.identifier(VECTORS[set])} v on v.product_id = ${products.id}
    where ${and(inArray(products.status, PUBLIC.statuses), notDown, listedByDefault, notAuditHeld)}
      and ${distance} <= ${1 - MIN_SIMILARITY}
    order by ${distance}, ${products.slug}
    limit ${CANDIDATES}
  `);
  return rows.map((row) => row.slug);
}

async function inspectCohort(variants: readonly Variant[]): Promise<RankingOutput["cohort"]> {
  const productCount = await countProducts({ statuses: PUBLIC.statuses });
  if (!productCount) throw new Error("readme_experiment_empty_corpus");
  const wanted = new Set<VectorSet>();
  for (const variant of variants) {
    if (wantsReadme(variant)) {
      wanted.add("V0");
      wanted.add("README");
    } else {
      wanted.add(variant);
    }
  }
  const counts: RankingOutput["cohort"]["vectors"] = {};
  for (const set of wanted) {
    const [row] = await db.execute<{ count: number; matched: number; without_readme: number }>(sql`
      select count(*)::int as count,
        count(*) filter (where ${inArray(products.status, PUBLIC.statuses)})::int as matched,
        count(*) filter (where nullif(btrim(${products.searchReadme}), '') is null)::int as without_readme
      from ${sql.identifier(VECTORS[set])} v
      left join ${products} on ${products.id} = v.product_id
    `);
    if (row.count !== row.matched || (set === "README" ? row.count === 0 || row.without_readme > 0 : row.count !== productCount)) {
      throw new Error(`readme_experiment_incomplete_vectors_${set}`);
    }
    counts[set] = row.count;
  }
  return { products: productCount, eligibleProducts: await countProducts(PUBLIC), vectors: counts };
}

async function rankOne(
  query: string,
  slug: string,
  variant: Variant,
  translation: Translation,
  rerank: boolean,
  models: Models,
  embedding: { vector: number[]; ms: number },
): Promise<{ rrf: RankingQuery; reranked: RankingQuery }> {
  const resolution = await timed(() => resolveExperimentQuery(query, translation));
  const resolved = resolution.value;
  const scope = { ...PUBLIC, query: resolved.queries };
  const readme = wantsReadme(variant);
  const [lexical, semantic] = await Promise.all([
    timed(() => Promise.all([
      listProductSlugs({ ...scope, sort: "relevance", limit: CANDIDATES }),
      countProducts(scope),
    ])),
    timed(() => Promise.all([
      nearestSlugs(embedding.vector, readme ? "V0" : variant),
      readme ? nearestSlugs(embedding.vector, "README") : [],
    ])),
  ]);
  const [fts, lexicalTotal] = lexical.value;
  const [nearest, readmeSlugs] = semantic.value;
  const fusionStarted = performance.now();
  const ftsSet = new Set(fts);
  const vectorOnly = [...new Set([...nearest, ...readmeSlugs])].filter((candidate) => !ftsSet.has(candidate));
  const alsoMatching = fts.length < CANDIDATES || vectorOnly.length === 0
    ? []
    : await listProductSlugs({ ...scope, slugs: vectorOnly, limit: vectorOnly.length });
  const hits = lexicalTotal + vectorOnly.length - alsoMatching.length;
  const head = fuse(fts, nearest, readme ? { slugs: readmeSlugs, weight: README_WEIGHTS[variant] } : undefined);
  const fusionMs = observed(fusionStarted);

  const timing = {
    translationMs: resolution.ms,
    embeddingModelMs: embedding.ms,
    lexicalMs: lexical.ms,
    semanticMs: semantic.ms,
    fusionMs,
    documentsMs: 0,
    rerankModelMs: 0,
    windowMs: 0,
  };
  // Keyword retrieval overlaps embedding and semantic retrieval on the request path.
  const retrievalMs = timing.translationMs + Math.max(timing.lexicalMs, timing.embeddingModelMs + timing.semanticMs) + timing.fusionMs;
  const ranked = { head, total: hits, semantic: true, reranked: false };
  const window = await timed(() => relevanceWindow(ranked, resolved.queries, {}, 0, DEPTH));
  timing.windowMs = window.ms;
  // Fetch diagnostic positions after the timed depth-20 response. Reranking permutes only the top 30.
  const tail = hits > head.length && head.length < DIAGNOSE_DEPTH
    ? await relevanceWindow(ranked, resolved.queries, {}, Math.max(head.length, DEPTH), DIAGNOSE_DEPTH - Math.max(head.length, DEPTH))
    : [];
  const extension = head.length > DEPTH ? head.slice(DEPTH, DIAGNOSE_DEPTH) : [];
  const slugs = [...window.value, ...extension, ...tail];
  const rrf = {
    query, slug, slugs, hits,
    ms: retrievalMs + timing.windowMs,
    translated: resolved.translated,
    translationPending: resolved.translationPending ?? false,
    cacheSource: resolved.cacheSource,
    builtInExpansions: resolved.builtInExpansions,
    reranked: false,
    timing,
  };
  if (!rerank || head.length === 0) return { rrf, reranked: rrf };

  const top = head.slice(0, RERANK_TOP);
  const docs = await timed(() => productDocuments(top));
  const { scores, ms } = await models.rerank(query, top.map((candidate) => docs.value.get(candidate) ?? candidate));
  if (scores.length !== top.length || scores.some((score) => !Number.isFinite(score))) {
    throw new Error("readme_experiment_invalid_rerank_scores");
  }
  const order = top.map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => scores[b.index] - scores[a.index] || a.index - b.index)
    .map(({ candidate }) => candidate);
  return {
    rrf,
    reranked: {
      ...rrf,
      slugs: [...order, ...slugs.slice(top.length)],
      ms: rrf.ms + docs.ms + ms,
      reranked: true,
      timing: { ...timing, documentsMs: docs.ms, rerankModelMs: ms },
    },
  };
}

export async function runReadmeEmbeddingSearch(client: postgres.Sql, models: Models, options: Options): Promise<RankingOutput> {
  // Bind existing repository helpers to the guarded local pool without reading application connection variables.
  const globals = globalThis as { db?: unknown; pgClient?: unknown; readDb?: unknown };
  if (globals.db || globals.pgClient || globals.readDb) throw new Error("readme_experiment_database_already_bound");
  globals.db = drizzle(client, { schema });
  globals.pgClient = client;
  const previousReadDb = globals.readDb;
  globals.readDb = null;
  try {
    const cohort = await inspectCohort(options.variants);
    const conditions = options.variants.flatMap((variant) => options.translations.map((translation) => ({
      variant, translation,
      runs: options.stages.map((stage) => ({ variant, translation, stage, queries: [] as RankingQuery[] })),
    })));
    const translationCoverage = options.translations.includes("cache")
      ? { eligible: 0, current: 0, legacy: 0, misses: 0, withBuiltInExpansions: 0 }
      : null;
    const output: RankingOutput = { cohort, translationCoverage, complete: false, runs: conditions.flatMap((condition) => condition.runs) };
    const checkpoint = options.outputPath ? `${options.outputPath}.partial` : undefined;
    for (const [index, [query, slug]] of options.queries.entries()) {
      const embedding = await models.embedQuery(query);
      const offset = index % conditions.length;
      let cacheRanking: RankingQuery | undefined;
      // Rotate the starting condition so one variant does not always get colder buffers.
      for (const condition of [...conditions.slice(offset), ...conditions.slice(0, offset)]) {
        const rankings = await rankOne(query, slug, condition.variant, condition.translation,
          options.stages.includes("reranked"), models, embedding);
        for (const run of condition.runs) run.queries.push(rankings[run.stage]);
        if (condition.translation === "cache") cacheRanking ??= rankings.rrf;
      }
      if (translationCoverage && cacheRanking && searchQuerySourceLocale(query)) {
        translationCoverage.eligible++;
        translationCoverage[cacheRanking.cacheSource ?? "misses"]++;
        if (cacheRanking.builtInExpansions.length) translationCoverage.withBuiltInExpansions++;
      }
      if (checkpoint) writeFileSync(checkpoint, JSON.stringify(output));
      options.progress?.(index + 1, options.queries.length);
    }
    output.complete = true;
    if (checkpoint && options.outputPath) {
      writeFileSync(checkpoint, JSON.stringify(output, null, 2));
      renameSync(checkpoint, options.outputPath);
    }
    return output;
  } finally {
    delete globals.db;
    delete globals.pgClient;
    globals.readDb = previousReadDb;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      scratch: { type: "string" },
      variants: { type: "string" },
      "max-queries": { type: "string" },
      "no-translation": { type: "boolean" },
      "rrf-only": { type: "boolean" },
    },
  });
  if (!values.out || !values.scratch) throw new Error("pass --out and --scratch for the experiment files");
  const variants = values.variants ? [...new Set(values.variants.split(","))] : [...VARIANTS];
  const validVariant = (variant: string): variant is Variant => VARIANTS.some((value) => value === variant);
  if (!variants.every(validVariant)) throw new Error("unknown README experiment variant");
  const limit = values["max-queries"] ? Number(values["max-queries"]) : JUDGED.length;
  if (!Number.isInteger(limit) || limit < 1 || limit > JUDGED.length) throw new Error("invalid --max-queries");

  const client = openReadmeExperimentDatabase(4);
  try {
    const models = createSearchModelClient({ scratch: values.scratch });
    try {
      await runReadmeEmbeddingSearch(client, models, {
        variants,
        translations: values["no-translation"] ? ["none"] : ["cache", "none"],
        queries: JUDGED.slice(0, limit),
        stages: values["rrf-only"] ? ["rrf"] : ["rrf", "reranked"],
        outputPath: values.out,
        progress: (done, total) => console.log(`Ranked ${done}/${total} queries`),
      });
    } finally {
      await models.close();
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  main().catch((error: unknown) => {
    // Driver errors can include SQL parameters. Keep the CLI output to a diagnostic code.
    const failure = error as { code?: unknown; message?: unknown };
    console.error(typeof failure.code === "string" ? failure.code
      : typeof failure.message === "string" && !failure.message.includes("\n") ? failure.message : "readme_experiment_search_failed");
    process.exitCode = 1;
  });
}
