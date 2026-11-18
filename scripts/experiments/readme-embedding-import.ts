import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { openReadmeExperimentDatabase } from "./readme-embedding-db";

async function insertSnapshot(
  db: postgres.TransactionSql,
  table: "products" | "text_translations",
  file: string,
): Promise<number> {
  const attributes = await db<{ column_name: string }[]>`
    select attname as column_name
    from pg_attribute
    where attrelid = ${`public.${table}`}::regclass
      and attnum > 0 and not attisdropped and attgenerated = ''
    order by attnum
  `;
  const columns = attributes.map(({ column_name }) => column_name);
  const content = await readFile(file, "utf8");
  const value = table === "products" ? db`entry.row_json -> 'r'` : db`entry.row_json`;

  try {
    // Bind serialized JSON as text so postgres.js does not quote it as a JSON string.
    const result = await db`
      insert into ${db(`public.${table}`)} (${db(columns)})
      select ${db(columns)}
      from jsonb_array_elements(${content}::text::jsonb) as entry(row_json)
      cross join lateral jsonb_populate_record(null::${db(`public.${table}`)}, ${value})
    `;
    return result.count;
  } catch (error) {
    // PostgreSQL error details can contain raw snapshot row values.
    if (error instanceof postgres.PostgresError) {
      throw new Error(`Could not import ${file} (SQLSTATE ${error.code}).`);
    }
    throw error;
  }
}

async function main() {
  const [dataDirectory, ...extra] = process.argv.slice(2);
  if (!dataDirectory || extra.length) {
    throw new Error("Usage: tsx scripts/experiments/readme-embedding-import.ts <snapshot data directory>");
  }
  const productFiles = (await readdir(dataDirectory))
    .filter((name) => /^products_\d+\.json$/.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (!productFiles.length) throw new Error("No products_<start id>.json files in the snapshot directory.");

  const db = openReadmeExperimentDatabase();
  try {
    const counts = await db.begin(async (tx) => {
      await tx`lock table public.products, public.text_translations in share row exclusive mode`;
      const [state] = await tx<{ occupied: boolean }[]>`
        select exists (select from public.products)
          or exists (select from public.text_translations) as occupied
      `;
      if (state.occupied) throw new Error("Use a freshly migrated experiment database with empty snapshot tables.");

      let products = 0;
      for (const file of productFiles) {
        const count = await insertSnapshot(tx, "products", join(dataDirectory, file));
        console.log(`${file} staged ${count} rows`);
        products += count;
      }
      const translations = await insertSnapshot(
        tx,
        "text_translations",
        join(dataDirectory, "text_translations_en.json"),
      );
      const [invalid] = await tx<{ found: boolean }[]>`
        select exists (select from public.products where status not in ('seeded', 'verified'))
          or exists (select from public.text_translations where target_lang <> 'en') as found
      `;
      if (!products || invalid.found) throw new Error("Snapshot has no products or contains out-of-scope rows.");

      await tx`
        select setval(pg_get_serial_sequence('public.products', 'id'), max(id)) from public.products
      `;
      return { products, translations };
    });
    await db`analyze public.products, public.text_translations`;
    console.log(`Committed ${counts.products} products and ${counts.translations} English translation cache rows.`);
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof postgres.PostgresError
    ? `Database operation failed (SQLSTATE ${error.code}).`
    : error instanceof Error ? error.message : "Unknown import failure.";
  console.error(message);
  process.exitCode = 1;
});
