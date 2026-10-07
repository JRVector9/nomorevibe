import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { EMBEDDING_DOCUMENT, EMBEDDING_MODEL, embedTexts, EmbeddingUnavailableError, vectorLiteral } from "@/lib/domain/products/embedding";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { withJobLeaseWrite } from "@/lib/jobs/control";

/**
 * 제품 벡터 채우기 — 공개 제품의 글(EMBEDDING_DOCUMENT)을 임베딩해 product_embeddings 에 둔다.
 *
 * text 워커에서 돈다(키워드 짓기와 같은 자리 — 키워드가 바뀌면 글이 바뀌어 여기서 다시 임베딩한다).
 * 커서가 없다. 벡터가 없거나 글·모델이 바뀐 행만 골라 고치므로, 다 채운 뒤에는 매 틱이 조인 한 번이다.
 * 서버는 한 묶음(64건)에 약 0.8초라 틱 하나(50초)에 3천 건 남짓 — 공개분 3만5천 건을 처음 채우는 데 십여 틱이다.
 */

/** 한 번에 보내는 글 수 — 서버가 8칸으로 나눠 동시에 처리한다 */
const BATCH = 64;
/** 한 묶음에 둘 시간. 평소 1초 안쪽이다 */
const CALL_MS = 30_000;

type Pending = { id: number; hash: string; text: string };

export async function refreshProductEmbeddings(
  ctx: JobContext<null>,
  deps: { embed?: (texts: string[], signal?: AbortSignal) => Promise<number[][]> } = {},
): Promise<JobOutcome<null>> {
  const embed = deps.embed ?? ((texts: string[], signal?: AbortSignal) => embedTexts(texts, { timeoutMs: CALL_MS, signal }));
  let written = 0;
  while (ctx.hasBudget() && !ctx.signal?.aborted) {
    const rows = await db.execute<Pending>(sql`
      select ${products.id} as id, md5(${EMBEDDING_DOCUMENT}) as hash, ${EMBEDDING_DOCUMENT} as text
        from ${products}
        left join product_embeddings e on e.product_id = ${products.id}
       where ${products.status} in ('seeded', 'verified')
         and (e.product_id is null or e.model <> ${EMBEDDING_MODEL} or e.text_hash <> md5(${EMBEDDING_DOCUMENT}))
       order by ${products.id} desc
       limit ${BATCH}`);
    const pending = [...rows];
    if (pending.length === 0) {
      ctx.log("product_embedding.done", { written, drained: true });
      return { done: true };
    }
    let vectors: number[][];
    try {
      vectors = await embed(pending.map((row) => row.text), ctx.signal);
    } catch (error) {
      // 서버가 없거나 쉬는 것은 이 제품들의 문제가 아니다 — 다음 틱에 다시 본다
      if (!(error instanceof EmbeddingUnavailableError)) throw error;
      ctx.log("product_embedding.unavailable", { written, reason: error.message });
      return { done: true };
    }
    const values = sql.join(pending.map((row, i) =>
      sql`(${row.id}, ${EMBEDDING_MODEL}, ${row.hash}, ${vectorLiteral(vectors[i])}::halfvec, now())`), sql`, `);
    await withJobLeaseWrite(ctx.lease, (tx) => tx.execute(sql`
      insert into product_embeddings (product_id, model, text_hash, embedding, embedded_at)
      values ${values}
      on conflict (product_id) do update
        set model = excluded.model, text_hash = excluded.text_hash, embedding = excluded.embedding, embedded_at = excluded.embedded_at`));
    written += pending.length;
    if (pending.length < BATCH) {
      ctx.log("product_embedding.done", { written, drained: true });
      return { done: true };
    }
  }
  ctx.log("product_embedding.progress", { written });
  return { done: false };
}
