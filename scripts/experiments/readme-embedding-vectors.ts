import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PgDialect } from "drizzle-orm/pg-core";
import type postgres from "postgres";
import {
  EMBEDDING_DOCUMENT, EMBEDDING_MODEL, EMBEDDING_PARITY_MIN_COSINE, EMBEDDING_PREPROCESSING_HASH, embeddingParity, vectorLiteral,
} from "../../lib/domain/products/embedding";
import { openReadmeExperimentDatabase } from "./readme-embedding-db";
import { createSearchModelClient, hashModelInput, MAX_MODEL_BATCH } from "./readme-embedding-model";
import { cleanReadme, prefix } from "./readme-embedding-text";

type Product = { id: number; document: string; readme: string | null };
type Variant = "v0" | "v1" | "v1raw" | "v2";
type Input = { productId: number; text: string; hash: string };
type Model = ReturnType<typeof createSearchModelClient>;

function productInput(productId: number, text: string): Input {
  return { productId, text, hash: hashModelInput(text) };
}

async function parity(db: postgres.Sql, model: Model, samples: readonly Input[], scratch: string) {
  const [first, second] = await model.parity(samples.map(({ text }) => text));
  const repeat = embeddingParity(first.map((observed, index) => ({ observed, stored: second[index] })));
  const rounded = await db<{ embedding: string }[]>`
    SELECT embedding::halfvec(1024)::text AS embedding
    FROM unnest(${db.array(second.map(vectorLiteral))}::text[]) AS rows(embedding)
  `;
  const storage = embeddingParity(first.map((observed, index) => ({ observed, stored: JSON.parse(rounded[index].embedding) })));
  const result = { repeat, halfvecRoundTrip: storage, model: EMBEDDING_MODEL, preprocessingHash: EMBEDDING_PREPROCESSING_HASH };
  writeFileSync(join(scratch, "embedding-parity.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (Math.min(repeat.minCosine, storage.minCosine) < EMBEDDING_PARITY_MIN_COSINE) throw new Error("Embedding parity below 0.999");
  return first;
}

async function saveBatch(db: postgres.Sql, inputs: readonly Input[], vectors: readonly number[][]) {
  await db`
    INSERT INTO readme_exp_input_cache (hash, embedding)
    SELECT hash, embedding::halfvec(1024)
    FROM unnest(${db.array(inputs.map(({ hash }) => hash))}::text[], ${db.array(vectors.map(vectorLiteral))}::text[])
    AS rows(hash, embedding)
    ON CONFLICT (hash) DO NOTHING
  `;
}

async function prepareVariant(db: postgres.Sql, model: Model, variant: Variant, inputs: Input[], known: Set<string>) {
  const pending = new Map<string, Input>();
  for (const input of inputs) if (!known.has(input.hash)) pending.set(input.hash, input);
  const newInputs = [...pending.values()];
  console.log(`${variant}: ${inputs.length} rows, ${newInputs.length} unique input cache misses`);
  for (let offset = 0; offset < newInputs.length; offset += MAX_MODEL_BATCH) {
    const batch = newInputs.slice(offset, offset + MAX_MODEL_BATCH);
    const vectors = await model.embedBatch(batch.map(({ text }) => text), variant);
    await saveBatch(db, batch, vectors);
    for (const { hash } of batch) known.add(hash);
    await model.checkpoint();
    if ((offset / MAX_MODEL_BATCH + 1) % 50 === 0 || offset + batch.length === newInputs.length) {
      console.log(`${variant}: ${offset + batch.length}/${newInputs.length} new vectors saved`);
    }
  }

  const table = "readme_exp_" + variant;
  await db.begin(async (tx) => {
    await tx`CREATE TABLE IF NOT EXISTS ${tx(table)} (product_id integer PRIMARY KEY, embedding halfvec(1024) NOT NULL)`;
    await tx`TRUNCATE ${tx(table)}`;
    for (let offset = 0; offset < inputs.length; offset += 5_000) {
      const rows = inputs.slice(offset, offset + 5_000);
      await tx`
        INSERT INTO ${tx(table)} (product_id, embedding)
        SELECT rows.product_id, cached.embedding
        FROM unnest(${tx.array(rows.map(({ productId }) => productId))}::int[], ${tx.array(rows.map(({ hash }) => hash))}::text[])
        AS rows(product_id, hash)
        JOIN readme_exp_input_cache AS cached USING (hash)
      `;
    }
    const [result] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM ${tx(table)}`;
    if (result.count !== inputs.length) throw new Error(`${variant} is missing vectors`);
  });
  await db`ANALYZE ${db(table)}`;
  console.log(`${variant}: ${inputs.length} vectors materialized`);
}

async function main() {
  const { values } = parseArgs({
    options: { scratch: { type: "string" }, raw: { type: "boolean" }, "parity-only": { type: "boolean" } },
  });
  if (!values.scratch) throw new Error("Provide --scratch=<private experiment directory>");
  const scratch = values.scratch;
  const db = openReadmeExperimentDatabase();
  const model = createSearchModelClient({ scratch });
  try {
    const document = new PgDialect().sqlToQuery(EMBEDDING_DOCUMENT);
    const products = await db.unsafe<Product[]>(`
      SELECT id, ${document.sql} AS document, search_readme AS readme
      FROM products WHERE status IN ('seeded', 'verified') ORDER BY id
      ${values["parity-only"] ? "LIMIT 256" : ""}
    `, document.params as number[]);
    if (!values["parity-only"] && products.length !== 100_476) throw new Error(`Expected 100476 products, found ${products.length}`);
    const v0 = products.map(({ id, document }) => productInput(id, document));
    const samples = [...new Map(v0.slice(0, 256).map((input) => [input.hash, input])).values()].slice(0, MAX_MODEL_BATCH);
    const sampleVectors = await parity(db, model, samples, scratch);
    await db`CREATE TABLE IF NOT EXISTS readme_exp_input_cache (hash text PRIMARY KEY, embedding halfvec(1024) NOT NULL)`;
    await saveBatch(db, samples, sampleVectors);
    if (values["parity-only"]) return;

    const readmes = products.map(({ readme }) => cleanReadme(readme ?? ""));
    const v1 = v0.map((input, index) => readmes[index]
      ? productInput(input.productId, input.text + "\n\n" + prefix(readmes[index], 800)) : input);
    const v2 = v0.flatMap(({ productId }, index) => readmes[index]
      ? [productInput(productId, prefix(readmes[index], 1_000))] : []);
    const v1raw = values.raw ? v0.map((input, index) => {
      const readme = products[index].readme;
      return readme?.trim() ? productInput(input.productId, input.text + "\n\n" + prefix(readme, 800)) : input;
    }) : null;
    const saved = await db<{ hash: string }[]>`SELECT hash FROM readme_exp_input_cache`;
    const known = new Set(saved.map(({ hash }) => hash));
    const plans: [Variant, Input[]][] = [["v0", v0], ["v1", v1], ["v2", v2]];
    if (v1raw) plans.push(["v1raw", v1raw]);
    const planning = {
      products: products.length,
      readmeNonblank: products.filter(({ readme }) => readme?.trim()).length,
      cleanedReadme: v2.length,
      variantRows: Object.fromEntries(plans.map(([variant, inputs]) => [variant, inputs.length])),
    };
    writeFileSync(join(scratch, "embedding-plan.json"), JSON.stringify(planning, null, 2));
    console.log(JSON.stringify(planning));
    for (const [variant, inputs] of plans) await prepareVariant(db, model, variant, inputs, known);
    const sizes = await db`
      SELECT relname, pg_relation_size(oid)::int AS heap_bytes, pg_total_relation_size(oid)::int AS total_bytes
      FROM pg_class WHERE relname IN ('readme_exp_v0', 'readme_exp_v1', 'readme_exp_v1raw', 'readme_exp_v2') ORDER BY relname
    `;
    writeFileSync(join(scratch, "embedding-storage.json"), JSON.stringify(sizes, null, 2));
  } finally {
    await model.close();
    await db.end();
  }
}

main().catch((error: unknown) => {
  // Do not print connection strings or product inputs from database errors.
  console.error(error instanceof Error ? error.message : "Experiment vector run failed");
  process.exitCode = 1;
});
