/**
 * 4개 언어 검색 평가 — 같은 의도의 질의를 영어·한국어·중국어·일본어로 넣고, 중·일 검색어를 영어로 옮기는 안을 잰다.
 *
 * 평가셋은 multilingual-search-queries.json 이다. scripts/search-judged.ts 의 정답 질의 60개(key)마다 네 언어판이 있고,
 * 네 판 모두 key 의 채점(search-judgments.json + 이 실험이 보탠 multilingual-search-judgments-extra.json)을 쓴다.
 *
 * 실험안(arm). 영어 질의는 어느 안에서도 바뀌지 않는다:
 *  - cold              번역 캐시가 빈 운영 — 한국어는 정해 둔 확장(queryExpansions)만, 0건이면 운영처럼 번역을 기다려 다시 찾는다
 *  - current           번역 캐시가 찬 운영 — 한국어(와 정해진 12낱말이 든 중국어)는 번역 표현을 낱말 검색에 함께 넣는다
 *  - current-prodcache 보정용 — 한국어 번역을 대리 번역이 아니라 운영 캐시(text_translations)에서만 읽는다
 *  - cjk               current + 한글 없이 한자·가나가 든 질의(중·일)도 번역 표현을 낱말 검색에 함께 넣는다
 *  - cjk+vec           cjk + 번역 표현을 임베딩한 세 번째 목록을 RRF 로 섞는다(번역이 있는 모든 질의)
 *  - cjk+rr            cjk + 재정렬 질의에 번역 표현을 덧붙인다
 *  - cjk+vec+rr        둘 다
 * 의미 검색·재정렬은 운영처럼 사람이 친 말(raw)로 한다. 바꾸는 안만 위에 적은 대로 다르다.
 *
 * 번역은 대리 번역이다(scripts/experiments/multilingual-search-translations.json — 운영 지시문으로 Claude Sonnet 이 답한 것).
 * 운영 번역 엔진(M3 gpt-oss)은 웹 검색과 칸을 나눠 써 장부 밖에서 부르지 않았다. current-prodcache 가 둘의 차이를 잰다.
 *
 *   NMV_ML_SEARCH_DB_URL=... tsx scripts/experiments/multilingual-search-eval.ts run --scratch=DIR --out=runs.json [--arms=a,b] [--langs=ko,zh]
 *   tsx scripts/experiments/multilingual-search-eval.ts pool --runs=runs.json --out=pool.json --map=pool-map.json   (DB 필요)
 *   tsx scripts/experiments/multilingual-search-eval.ts merge --grades=a.json,b.json --map=pool-map.json --out=scripts/experiments/multilingual-search-judgments-extra.json
 *   tsx scripts/experiments/multilingual-search-eval.ts score --runs=runs.json [--extra=judgments-extra.json] --out=score.json
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../lib/db/schema";
import { GLOSSARY_VERSION, QUERY_PROMPT_VERSION, glossaryHints, parseQueryTranslation, queryExpansions, queryTranslationPhrases, textHash } from "../../lib/crawl/translate";
import { CANDIDATES, MIN_SIMILARITY, RERANK_TOP, fuseRanks, type RankedSearch } from "../../lib/domain/products/hybrid-search";
import { rankRelevance, relevanceWindow } from "../../lib/domain/products/relevance";
import { countProducts, listProductSlugs, nearestProductSlugs, productDocuments } from "../../lib/domain/products/repository";
import type { SearchQuery } from "../../lib/domain/products/search";
import { normalizeQuery, planSearch, queryTranslationKey, searchQuerySourceLocale } from "../../lib/domain/products/search-translation";
import { createSearchModels, type SearchModels } from "./multilingual-search-model";
import { ARMS, LANGS, bootstrapMean, cjkQuery, loadTuples, ndcg, type Arm, type Lang } from "./multilingual-search-shared";


const HERE = __dirname;
const TRANSLATIONS_FILE = path.join(HERE, "multilingual-search-translations.json");
const BASE_JUDGMENTS_FILE = path.join(HERE, "..", "search-judgments.json");
const CONTAINER = "nmv-ml-search-exp-pg";
const PUBLIC = { statuses: ["verified", "seeded"] as schema.ProductStatus[], excludeDown: true };
const DEPTH = 20;
const DIAGNOSE_DEPTH = 200;



// ---------- DB ----------

function openDatabase(): postgres.Sql {
  const url = process.env.NMV_ML_SEARCH_DB_URL;
  if (!url) throw new Error("Set NMV_ML_SEARCH_DB_URL to the experiment container's loopback URL");
  const parsed = new URL(url);
  const binding = execFileSync("docker", ["port", CONTAINER, "5432/tcp"], { encoding: "utf8", timeout: 5000 }).trim();
  if (parsed.hostname !== "127.0.0.1" || binding !== `127.0.0.1:${parsed.port}` || parsed.pathname !== "/nomorevibe_test") {
    throw new Error(`NMV_ML_SEARCH_DB_URL must be the loopback port of ${CONTAINER}`);
  }
  const client = postgres(url, { max: 4, connect_timeout: 5, onnotice: () => {} });
  const globals = globalThis as { db?: unknown; pgClient?: unknown; readDb?: unknown };
  if (globals.db || globals.pgClient) throw new Error("database already bound");
  // lib/db 의 db 프록시가 이 연결을 쓰게 한다 — DATABASE_URL 을 읽지 않는다
  globals.db = drizzle(client, { schema });
  globals.pgClient = client;
  globals.readDb = null;
  return client;
}

// ---------- 번역 ----------

type Translations = Record<string, string>;
/** 대리 번역 원문 답 → 운영 파서(parseQueryTranslation)를 지난 저장 형태 */
function loadTranslations(): Translations {
  const raw: Record<string, string> = JSON.parse(readFileSync(TRANSLATIONS_FILE, "utf8")).answers;
  const parsed: Translations = {};
  for (const [query, answer] of Object.entries(raw)) {
    const value = parseQueryTranslation(answer);
    if (value) parsed[query] = value;
  }
  return parsed;
}

/** 9e95dc37 전의 한국어 캐시 열쇠 — 지시문·용어표 판은 그대로라 같은 번역이다(README 실험과 같은 읽기) */
function legacyKoreanKey(query: string): string {
  const normalized = normalizeQuery(query);
  const glossary = glossaryHints(normalized) ? `g${GLOSSARY_VERSION}` : "";
  return textHash(`q${QUERY_PROMPT_VERSION}${glossary}:${normalized}`);
}

async function productionCache(query: string): Promise<string | null> {
  const { db } = await import("../../lib/db");
  const keys = [queryTranslationKey(query), legacyKoreanKey(query)];
  const rows = await db.select({ hash: schema.textTranslations.sourceHash, text: schema.textTranslations.translated })
    .from(schema.textTranslations)
    .where(and(eq(schema.textTranslations.targetLang, "en"), eq(schema.textTranslations.status, "done"), inArray(schema.textTranslations.sourceHash, keys)));
  return rows.find((row) => row.hash === keys[0])?.text ?? rows.find((row) => row.hash === keys[1])?.text ?? null;
}

type Plan = { phrases: string[]; extraVector: string | null; rerankQuery: string; translated: string | null; translationSource: "proxy" | "production-cache" | null };

async function planFor(arm: Arm, raw: string, translations: Translations): Promise<Plan> {
  const productionLocale = searchQuerySourceLocale(raw);
  const expansions = productionLocale === "ko" ? queryExpansions(raw) : [];
  let stored: string | null = null;
  if (arm === "cold") stored = null;
  else if (arm === "current-prodcache") stored = productionLocale === "ko" ? await productionCache(raw) : null;
  else if (productionLocale) stored = translations[raw] ?? null;
  else if (arm !== "current" && cjkQuery(raw)) stored = translations[raw] ?? null;
  const translationSource = !stored ? null : arm === "current-prodcache" ? "production-cache" as const : "proxy" as const;
  const phrases = [...new Set([...(stored ? queryTranslationPhrases(stored) : []), ...expansions])];
  const translated = phrases.length ? phrases.join(" / ") : null;
  const withVector = arm === "cjk+vec" || arm === "cjk+vec+rr";
  const withRerank = arm === "cjk+rr" || arm === "cjk+vec+rr";
  return {
    phrases,
    translated,
    translationSource,
    extraVector: withVector && translated ? translated : null,
    rerankQuery: withRerank && translated ? `${raw} / ${translated}` : raw,
  };
}

async function searchPlan(raw: string, phrases: string[]): Promise<SearchQuery> {
  const texts = [raw, ...phrases];
  return { ...await planSearch(texts), groups: texts.map((_, index) => (index === 0 ? 0 : 1)) };
}

// ---------- 순위 ----------

/**
 * hybrid-search.ts rankSearch 와 같은 계산에 벡터 목록 하나(번역 표현)와 재정렬 질의만 바꿀 수 있게 했다.
 * 둘 다 쓰지 않으면 운영 rankRelevance 와 같은 결과여야 한다 — run 이 current 안마다 맞춰 본다.
 */
async function rankVariant(raw: string, plan: SearchQuery, extraVector: string | null, rerankQuery: string, models: SearchModels): Promise<RankedSearch> {
  const scope = { ...PUBLIC, query: plan };
  const vector = await models.embedQuery(raw);
  const extra = extraVector ? await models.embedQuery(extraVector) : null;
  const [fts, ftsTotal, nearest, nearestExtra] = await Promise.all([
    listProductSlugs({ ...scope, sort: "relevance", limit: CANDIDATES }),
    countProducts(scope),
    nearestProductSlugs(vector, PUBLIC, CANDIDATES, MIN_SIMILARITY),
    extra ? nearestProductSlugs(extra, PUBLIC, CANDIDATES, MIN_SIMILARITY) : Promise.resolve(null),
  ]);
  const ftsSet = new Set(fts);
  const vectorOnly = [...new Set([...nearest, ...(nearestExtra ?? [])])].filter((slug) => !ftsSet.has(slug));
  const alsoMatching = fts.length < CANDIDATES || vectorOnly.length === 0 ? [] : await listProductSlugs({ ...scope, slugs: vectorOnly, limit: vectorOnly.length });
  const fused = fuseRanks(nearestExtra ? [fts, nearest, nearestExtra] : [fts, nearest]);
  const total = ftsTotal + vectorOnly.length - alsoMatching.length;
  if (fused.length === 0) return { head: [], total, semantic: true, reranked: false };
  const top = fused.slice(0, RERANK_TOP);
  const texts = await productDocuments(top);
  const scores = await models.rerank(rerankQuery, top.map((slug) => texts.get(slug) ?? slug));
  const order = top.map((slug, index) => ({ slug, score: scores[index], index }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map((row) => row.slug);
  return { head: [...order, ...fused.slice(RERANK_TOP)], total, semantic: true, reranked: true };
}

export type RunRow = {
  arm: Arm; lang: Lang; key: string; slug: string; query: string;
  translated: string | null; translationSource: Plan["translationSource"]; extraVector: string | null; rerankQuery: string;
  hits: number; top: string[]; rank: number | null; deepRank: number | null; waitedForTranslation: boolean;
};

async function runCommand(values: Record<string, string | boolean | undefined>) {
  if (typeof values.scratch !== "string" || typeof values.out !== "string") throw new Error("pass --scratch and --out");
  const arms = (typeof values.arms === "string" ? values.arms.split(",") : [...ARMS]) as Arm[];
  const langs = (typeof values.langs === "string" ? values.langs.split(",") : [...LANGS]) as Lang[];
  if (!arms.every((arm) => (ARMS as readonly string[]).includes(arm)) || !langs.every((lang) => (LANGS as readonly string[]).includes(lang))) throw new Error("unknown arm or lang");
  const client = openDatabase();
  const models = createSearchModels(values.scratch);
  const tuples = loadTuples().slice(0, values.smoke ? 2 : undefined);
  const translations = loadTranslations();
  const rows: RunRow[] = [];
  let parityChecked = 0;
  const parityMismatch: string[] = [];
  try {
    const [{ count }] = await client<{ count: number }[]>`select count(*)::int as count from product_embeddings`;
    const publicCount = await countProducts({ statuses: PUBLIC.statuses });
    // --smoke 는 벡터가 다 차기 전에 앞 두 묶음으로 길만 확인한다 — 결과는 평가에 쓰지 않는다
    if (count !== publicCount && !values.smoke) throw new Error(`product_embeddings ${count} != public products ${publicCount}`);
    const started = Date.now();
    for (const [index, tuple] of tuples.entries()) {
      for (const lang of langs) {
        const raw = tuple[lang];
        // 영어는 어느 안에서도 같은 계획이다 — 같은 순위를 안마다 다시 재지 않고 한 번만 잰다
        const armList = lang === "en" ? arms.filter((arm) => arm === arms[0]) : arms;
        for (const arm of armList) {
          let plan = await planFor(arm, raw, translations);
          let queries = await searchPlan(raw, plan.phrases);
          let ranked = await rankVariant(raw, queries, plan.extraVector, plan.rerankQuery, models);
          let waited = false;
          // 운영 searchRelevance — 번역 없이 0건이고 운영이 옮기는 말이면 번역을 기다려 다시 찾는다
          if (arm === "cold" && ranked.total === 0 && searchQuerySourceLocale(raw) && translations[raw]) {
            plan = await planFor("current", raw, translations);
            queries = await searchPlan(raw, plan.phrases);
            ranked = await rankVariant(raw, queries, plan.extraVector, plan.rerankQuery, models);
            waited = true;
          }
          if (arm === "current" && !plan.extraVector && plan.rerankQuery === raw) {
            const production = await rankRelevance(raw, queries, {}, { embed: models.embedQuery, rerank: models.rerank });
            parityChecked++;
            if (production.total !== ranked.total || production.head.join("\n") !== ranked.head.join("\n")) parityMismatch.push(`${lang}:${raw}`);
          }
          const top = await relevanceWindow(ranked, queries, {}, 0, DEPTH);
          const index20 = top.indexOf(tuple.slug);
          let deep = index20;
          if (deep < 0) deep = (await relevanceWindow(ranked, queries, {}, 0, DIAGNOSE_DEPTH)).indexOf(tuple.slug);
          const shared = { key: tuple.key, slug: tuple.slug, query: raw, translated: plan.translated, translationSource: plan.translationSource, extraVector: plan.extraVector, rerankQuery: plan.rerankQuery,
            hits: ranked.total, top, rank: index20 >= 0 ? index20 + 1 : null, deepRank: deep >= 0 ? deep + 1 : null, waitedForTranslation: waited };
          if (lang === "en") for (const each of arms) rows.push({ arm: each, lang, ...shared });
          else rows.push({ arm, lang, ...shared });
        }
      }
      const stats = models.stats();
      console.log(`${index + 1}/${tuples.length} tuples · ${Math.round((Date.now() - started) / 1000)}s · M3 calls ${stats.calls} cached ${stats.cached} pauses ${stats.pauses}`);
      writeFileSync(values.out + ".partial", JSON.stringify({ rows }));
    }
    const output = {
      createdAt: new Date().toISOString(), arms, langs, tuples: tuples.length, smoke: Boolean(values.smoke), embeddedProducts: count,
      parity: { checked: parityChecked, mismatches: parityMismatch },
      models: models.stats(), rows,
    };
    writeFileSync(values.out, JSON.stringify(output, null, 1));
    console.log(JSON.stringify(output.parity));
  } finally {
    await models.close();
    await client.end();
  }
}

// ---------- 채점 모음 ----------

type Judgments = Record<string, Record<string, number>>;
function loadJudgments(extraFile?: string): Judgments {
  const base: Judgments = JSON.parse(readFileSync(BASE_JUDGMENTS_FILE, "utf8"));
  if (!extraFile || !existsSync(extraFile)) return base;
  const extra: Judgments = JSON.parse(readFileSync(extraFile, "utf8")).judgments;
  const merged: Judgments = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(extra)])) {
    for (const slug of Object.keys(extra[key] ?? {})) if (base[key] && slug in base[key]) throw new Error(`extra judgment overrides base: ${key} / ${slug}`);
    merged[key] = { ...(base[key] ?? {}), ...(extra[key] ?? {}) };
  }
  return merged;
}

async function poolCommand(values: Record<string, string | boolean | undefined>) {
  if (typeof values.runs !== "string" || typeof values.out !== "string" || typeof values.map !== "string") throw new Error("pass --runs --out --map");
  const { rows } = JSON.parse(readFileSync(values.runs, "utf8")) as { rows: RunRow[] };
  const judgments = loadJudgments(typeof values.extra === "string" ? values.extra : undefined);
  const tuples = loadTuples();
  const pairs = new Map<string, { key: string; slug: string }>();
  for (const row of rows) for (const slug of row.top.slice(0, 10)) {
    if (!(slug in (judgments[row.key] ?? {}))) pairs.set(`${row.key}\u0000${slug}`, { key: row.key, slug });
  }
  const client = openDatabase();
  try {
    const slugs = [...new Set([...pairs.values()].map((pair) => pair.slug))];
    const products = await client<{ slug: string; name: string; tagline: string | null; description: string | null; topics: string | null; readme: string | null }[]>`
      select slug, name, tagline, description, search_topics as topics, search_readme as readme from products where slug = any(${slugs})`;
    const bySlug = new Map(products.map((product) => [product.slug, product]));
    const salt = "ml-search-20261118";
    const items = [...pairs.values()].map((pair) => {
      const id = createHash("sha256").update(`${salt}\u0000${pair.key}\u0000${pair.slug}`).digest("hex").slice(0, 16);
      const product = bySlug.get(pair.slug);
      const tuple = tuples.find((each) => each.key === pair.key)!;
      return {
        id, query: pair.key, queryLanguage: tuple.source,
        product: product ? {
          name: product.name, tagline: product.tagline ?? "", description: (product.description ?? "").slice(0, 800),
          topics: product.topics ?? "", readme: (product.readme ?? "").slice(0, 1000),
        } : null,
        pair,
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
    writeFileSync(values.map, JSON.stringify(Object.fromEntries(items.map((item) => [item.id, item.pair])), null, 1));
    writeFileSync(values.out, JSON.stringify(items.map((item) => ({ id: item.id, query: item.query, queryLanguage: item.queryLanguage, product: item.product })), null, 1));
    console.log(`${items.length} unjudged pairs over ${new Set(items.map((item) => item.query)).size} queries`);
  } finally {
    await client.end();
  }
}

/** 블라인드 채점 파일들 + ID 대응표 → 질의 → 제품 → 등급. ID 는 한 파일에 한 번씩, 모음의 모든 ID 가 있어야 한다 */
function mergeCommand(values: Record<string, string | boolean | undefined>) {
  if (typeof values.grades !== "string" || typeof values.map !== "string" || typeof values.out !== "string") throw new Error("pass --grades --map --out");
  const map: Record<string, { key: string; slug: string }> = JSON.parse(readFileSync(values.map, "utf8"));
  const seen = new Map<string, number>();
  for (const file of values.grades.split(",")) {
    const { judgments } = JSON.parse(readFileSync(file, "utf8")) as { judgments: { id: string; grade: number }[] };
    for (const { id, grade } of judgments) {
      if (!(id in map)) throw new Error(`unknown id ${id} in ${file}`);
      if (seen.has(id)) throw new Error(`id ${id} graded twice`);
      if (![0, 1, 2].includes(grade)) throw new Error(`bad grade for ${id}`);
      seen.set(id, grade);
    }
  }
  const missing = Object.keys(map).filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`${missing.length} pooled ids are not graded`);
  const previous: Judgments = existsSync(values.out) ? JSON.parse(readFileSync(values.out, "utf8")).judgments : {};
  const judgments: Judgments = structuredClone(previous);
  for (const [id, grade] of seen) {
    const { key, slug } = map[id];
    (judgments[key] ??= {})[slug] = grade;
  }
  const about = "Blind supplementary judgments for the 4-language search experiment (scripts/experiments/multilingual-search-grading.md). Keys are judged queries from scripts/search-judged.ts; merged on top of scripts/search-judgments.json.";
  writeFileSync(values.out, JSON.stringify({ about, judgments }, null, 1) + "\n");
  console.log(`${seen.size} grades merged; ${Object.values(judgments).reduce((sum, row) => sum + Object.keys(row).length, 0)} extra judgments in total`);
}

// ---------- 점수 ----------




function scoreCommand(values: Record<string, string | boolean | undefined>) {
  if (typeof values.runs !== "string" || typeof values.out !== "string") throw new Error("pass --runs --out");
  const { rows } = JSON.parse(readFileSync(values.runs, "utf8")) as { rows: RunRow[] };
  const judgments = loadJudgments(typeof values.extra === "string" ? values.extra : undefined);
  const tuples = loadTuples();
  const arms = ARMS.filter((arm) => rows.some((row) => row.arm === arm));
  const find = (arm: Arm, lang: Lang, key: string) => rows.find((row) => row.arm === arm && row.lang === lang && row.key === key);
  type Metrics = { ndcg10: number; rr: number; top1: number; top10: number; unjudged10: number; overlapEn10: number | null; relevant5: number };
  const metrics = (row: RunRow): Metrics => {
    const judged = judgments[row.key];
    const top10 = row.top.slice(0, 10);
    const en = find(row.arm, "en", row.key);
    return {
      ndcg10: ndcg(top10.map((slug) => judged[slug] ?? 0), Object.values(judged)),
      rr: row.rank ? 1 / row.rank : 0,
      top1: row.rank === 1 ? 1 : 0,
      top10: row.rank !== null && row.rank <= 10 ? 1 : 0,
      unjudged10: top10.filter((slug) => !(slug in judged)).length,
      relevant5: row.top.slice(0, 5).filter((slug) => (judged[slug] ?? 0) >= 1).length / 5,
      overlapEn10: row.lang === "en" || !en ? null : top10.filter((slug) => en.top.slice(0, 10).includes(slug)).length / 10,
    };
  };
  const summary: Record<string, Record<string, unknown>> = {};
  for (const arm of arms) {
    summary[arm] = {};
    for (const lang of LANGS) {
      const list = tuples.map((tuple) => find(arm, lang, tuple.key)).filter((row): row is RunRow => Boolean(row));
      if (list.length !== tuples.length) continue;
      const m = list.map(metrics);
      const mean = (pick: (x: Metrics) => number) => m.reduce((sum, x) => sum + pick(x), 0) / m.length;
      summary[arm][lang] = {
        n: m.length,
        ndcg10: bootstrapMean(m.map((x) => x.ndcg10)),
        mrr: mean((x) => x.rr), top1: mean((x) => x.top1), top10: mean((x) => x.top10), relevantTop5: mean((x) => x.relevant5),
        unjudgedTop10: m.reduce((sum, x) => sum + x.unjudged10, 0),
        overlapWithEnglishTop10: lang === "en" ? null : mean((x) => x.overlapEn10 ?? 0),
        medianHits: list.map((row) => row.hits).sort((a, b) => a - b)[Math.floor(list.length / 2)],
      };
    }
  }
  // 바꾼 안 − current 의 짝 차이(질의 묶음을 다시 뽑는 bootstrap). all 은 네 언어 평균을 묶음째로
  const deltas: Record<string, Record<string, unknown>> = {};
  for (const arm of arms.filter((arm) => arm !== "current")) {
    deltas[arm] = {};
    for (const lang of [...LANGS, "all"] as const) {
      const langs = lang === "all" ? LANGS : [lang];
      const diffs: number[] = [];
      const counts = { better: 0, worse: 0, same: 0 };
      for (const tuple of tuples) {
        let sum = 0;
        let ok = true;
        for (const each of langs) {
          const a = find(arm, each, tuple.key);
          const b = find("current", each, tuple.key);
          if (!a || !b) { ok = false; break; }
          const d = metrics(a).ndcg10 - metrics(b).ndcg10;
          sum += d;
          if (lang !== "all") counts[Math.abs(d) < 1e-9 ? "same" : d > 0 ? "better" : "worse"]++;
        }
        if (ok) diffs.push(sum / langs.length);
      }
      if (diffs.length === tuples.length) deltas[arm][lang] = { ndcg10: bootstrapMean(diffs), ...(lang === "all" ? {} : counts) };
    }
  }
  // 보정 — 원래 한국어 정답 질의 26개에서 운영 캐시 번역 vs 대리 번역
  const originalKorean = tuples.filter((tuple) => tuple.source === "ko");
  const calibration = arms.includes("current-prodcache") ? (() => {
    const diffs = originalKorean.map((tuple) => {
      const a = find("current", "ko", tuple.key);
      const b = find("current-prodcache", "ko", tuple.key);
      return a && b ? metrics(a).ndcg10 - metrics(b).ndcg10 : 0;
    });
    const covered = originalKorean.filter((tuple) => find("current-prodcache", "ko", tuple.key)?.translationSource === "production-cache").length;
    return { queries: originalKorean.length, productionCacheCovered: covered, proxyMinusProduction: bootstrapMean(diffs) };
  })() : null;
  const perQuery = rows.map((row) => ({ arm: row.arm, lang: row.lang, key: row.key, query: row.query, translated: row.translated, rank: row.rank, ...metrics(row) }));
  writeFileSync(values.out, JSON.stringify({ summary, deltas, calibration, perQuery }, null, 1));
  const fmt = (x: { mean: number; low: number; high: number }) => `${x.mean.toFixed(3)} [${x.low.toFixed(3)}, ${x.high.toFixed(3)}]`;
  for (const arm of arms) console.log(arm.padEnd(18), LANGS.map((lang) => {
    const s = summary[arm][lang] as { ndcg10: { mean: number } } | undefined;
    return `${lang} ${s ? s.ndcg10.mean.toFixed(3) : "  -  "}`;
  }).join("  "));
  for (const [arm, byLang] of Object.entries(deltas)) console.log(`Δ ${arm.padEnd(16)}`, Object.entries(byLang).map(([lang, value]) => `${lang} ${fmt((value as { ndcg10: { mean: number; low: number; high: number } }).ndcg10)}`).join("  "));
  if (calibration) console.log("calibration", JSON.stringify(calibration));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { smoke: { type: "boolean" }, scratch: { type: "string" }, out: { type: "string" }, arms: { type: "string" }, langs: { type: "string" }, runs: { type: "string" }, map: { type: "string" }, extra: { type: "string" }, grades: { type: "string" } },
  });
  if (command === "run") await runCommand(values);
  else if (command === "pool") await poolCommand(values);
  else if (command === "merge") mergeCommand(values);
  else if (command === "score") scoreCommand(values);
  else throw new Error("command: run | pool | merge | score");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((error: unknown) => {
    // 드라이버 오류에는 SQL 인자가 섞일 수 있다 — 코드나 한 줄 메시지만
    const failure = error as { code?: unknown; message?: unknown };
    console.error(typeof failure.code === "string" ? failure.code : typeof failure.message === "string" ? failure.message.split("\n")[0] : "failed");
    process.exitCode = 1;
  });
}
