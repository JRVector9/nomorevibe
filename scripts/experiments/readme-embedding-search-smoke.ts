import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/postgres-js";
import { QUERY_PROMPT_VERSION, textHash } from "@/lib/crawl/translate";
import * as schema from "@/lib/db/schema";
import { EMBEDDING_MODEL, vectorLiteral } from "@/lib/domain/products/embedding";
import { rankRelevance, relevanceWindow } from "@/lib/domain/products/relevance";
import { queryTranslationKey, resolveSearchQuery } from "@/lib/domain/products/search-translation";
import { openReadmeExperimentDatabase } from "./readme-embedding-db";
import { runReadmeEmbeddingSearch } from "./readme-embedding-search";

const ENGLISH = "plant disease detection";
const KOREAN = "식물 병 진단";
const LEGACY_KOREAN = "접근 가능한 공중화장실 지도";
const LEGACY_ENGLISH = "accessible public toilet map";
const NO_HIT = "xqzzvvqqz qwvvzzxxz";

const vector = (similarity: number, orthogonal = false) => Array.from({ length: 1024 }, (_, i) => {
  if (i === 0 && !orthogonal) return similarity;
  if (i === 1 && !orthogonal) return Math.sqrt(1 - similarity ** 2);
  return i === 2 && orthogonal ? 1 : 0;
});

async function main() {
  // Every fixture table is session-local. A single connection keeps temporary relations in scope.
  const client = openReadmeExperimentDatabase();
  let rerankedNoHit = false;
  const models = {
    embedQuery: async (query: string) => ({ vector: vector(1, query === NO_HIT), ms: 0.01 }),
    rerank: async (query: string, docs: readonly string[]) => {
      if (query === NO_HIT) rerankedNoHit = true;
      return { scores: docs.map((_, i) => i), ms: 0.02 };
    },
  };
  try {
    await client`create temp table products as select * from public.products
      where slug in ('capx-cafe', 'node-slack-sdk', 'product-589', 'restroom-map', 'smartspray', 'wheelmatch-ai')`;
    await client`update products set audit_hold_at = now() where slug = 'wheelmatch-ai'`;
    await client`create temp table text_translations as select * from public.text_translations with no data`;
    await client`insert into text_translations (source_hash, target_lang, status, translated)
      values (${queryTranslationKey(KOREAN)}, 'en', 'done', ${ENGLISH}),
        (${textHash(`q${QUERY_PROMPT_VERSION}:${KOREAN}`)}, 'en', 'done', 'ignored by current key'),
        (${textHash(`q${QUERY_PROMPT_VERSION}:${LEGACY_KOREAN}`)}, 'en', 'done', ${LEGACY_ENGLISH})`;
    await client`create temp table product_embeddings (product_id integer primary key, model text, embedding halfvec(1024))`;

    const nearest = vectorLiteral(vector(1));
    const distant = vectorLiteral(vector(0.25));
    const mid = vectorLiteral(vector(0.7));
    for (const table of ["readme_exp_v0", "readme_exp_v1", "readme_exp_v1raw", "readme_exp_v2"]) {
      await client`create temp table ${client(table)} (product_id integer primary key, embedding halfvec(1024))`;
      if (table === "readme_exp_v2") {
        await client`insert into ${client(table)} select id, ${nearest}::halfvec from products where slug = 'capx-cafe'`;
      } else {
        const promoted = table === "readme_exp_v1" ? "product-589" : "wheelmatch-ai";
        await client`insert into ${client(table)} select id,
          case when slug = ${promoted} then ${nearest}::halfvec
            when slug in ('smartspray', 'restroom-map') then ${mid}::halfvec
            else ${distant}::halfvec end from products`;
      }
    }
    await client`insert into product_embeddings select product_id, ${EMBEDDING_MODEL}, embedding from readme_exp_v0`;

    const output = await runReadmeEmbeddingSearch(client, models, {
      variants: ["V0", "V1", "V1raw", "V2@0.3", "V2@0.5", "V2@1.0"],
      translations: ["cache", "none"],
      queries: [[ENGLISH, "smartspray"], [KOREAN, "smartspray"], [LEGACY_KOREAN, "restroom-map"], [NO_HIT, "smartspray"]],
      stages: ["rrf", "reranked"],
    });
    assert.equal(output.complete, true);
    assert.equal(output.runs.length, 24);
    assert.equal(output.cohort.eligibleProducts, 5);
    assert.equal(output.cohort.vectors.README, 1);
    assert.deepEqual(output.translationCoverage, { eligible: 2, current: 1, legacy: 1, misses: 0, withBuiltInExpansions: 0 });
    for (const run of output.runs) {
      assert.equal(run.queries.length, 4);
      for (const result of run.queries) {
        assert(!result.slugs.includes("wheelmatch-ai"));
        assert.equal(result.slugs.length, result.hits);
        assert(Number.isFinite(result.ms));
      }
      assert.equal(run.queries[1].translated, run.translation === "cache" ? ENGLISH : null);
      assert.equal(run.queries[1].cacheSource, run.translation === "cache" ? "current" : null);
      assert.equal(run.queries[2].translated, run.translation === "cache" ? LEGACY_ENGLISH : null);
      assert.equal(run.queries[2].cacheSource, run.translation === "cache" ? "legacy" : null);
      assert(run.queries.every((result) => !result.translationPending));
      assert.equal(run.queries[3].hits, 0);
      assert.equal(run.queries[3].reranked, false);
    }
    assert.equal(rerankedNoHit, false);

    // Compare the V0 fixture with the production implementation using its original vector table.
    await client`insert into text_translations (source_hash, target_lang, status, translated)
      values (${queryTranslationKey(LEGACY_KOREAN)}, 'en', 'done', ${LEGACY_ENGLISH})`;
    const globals = globalThis as { db?: unknown; pgClient?: unknown; readDb?: unknown };
    globals.db = drizzle(client, { schema });
    globals.pgClient = client;
    globals.readDb = null;
    try {
      for (const run of output.runs.filter((item) => item.variant === "V0" && item.stage === "reranked")) {
        for (const result of run.queries) {
          const resolved = run.translation === "none" ? { queries: [result.query] }
            : await resolveSearchQuery(result.query, { waitForTranslation: false });
          const production = await rankRelevance(result.query, resolved.queries, {}, {
            embed: async (query) => (await models.embedQuery(query)).vector,
            rerank: async (query, docs) => (await models.rerank(query, docs)).scores,
          });
          assert.deepEqual(result.slugs, await relevanceWindow(production, resolved.queries, {}, 0, 200));
          assert.equal(result.hits, production.total);
        }
      }
    } finally {
      delete globals.db;
      delete globals.pgClient;
      delete globals.readDb;
    }
    const baseline = output.runs.find((run) => run.variant === "V0" && run.translation === "none" && run.stage === "rrf")!;
    const separate = output.runs.find((run) => run.variant === "V2@0.5" && run.translation === "none" && run.stage === "rrf")!;
    assert(!baseline.queries[0].slugs.includes("capx-cafe"));
    assert(separate.queries[0].slugs.includes("capx-cafe"));
    console.log("Offline retrieval smoke passed for 24 conditions × 4 queries.");
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const failure = error as { code?: unknown; name?: unknown; message?: unknown };
  console.error(typeof failure.code === "string" ? failure.code
    : failure.name === "AssertionError" ? failure.message : "readme_experiment_search_smoke_failed");
  process.exitCode = 1;
});
