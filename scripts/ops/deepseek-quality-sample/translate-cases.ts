/**
 * deepseek 품질 표본(2026-11-18) — 제품 번역(product-translate) 묶음·wire·검사.
 * 운영 판 ebd63092 의 productTranslationGatewayWire·packProductTranslationBatch·parseKoreanTaglines·checkProductTranslation 을 그대로 쓴다.
 * 묶음은 #985 방식(한 묶음 한 언어, 기존 4건·8,000자 포장)이다 — #985 는 wire 바이트를 바꾸지 않고 묶음 구성만 바꾼다.
 * 보조 채점: #986(미병합) 판 checkProductTranslation 을 translation-policy-pr986.ts 로 넣어 두면 en 결과를 그 검사로도 센다.
 *
 * 실행(ebd63092 트리 폴더에서):
 *   tsx translate-cases.ts build <candidates.json> <cases.jsonl> <model> <batchesPerLocale:en,zh-Hans,ja>
 *   tsx translate-cases.ts check <cases.jsonl> <responses.jsonl> <items.jsonl> [pr986]
 * candidates.json: 읽기 전용 SQL 결과(products 칸 + product_translations 칸). 운영 DB·모델을 부르지 않는다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { productTranslationGatewayWire } from "@/lib/crawl/translate";
import { parseKoreanTaglines } from "@/lib/domain/products/korean-tagline";
import { checkProductTranslation, packProductTranslationBatch, productTranslationSourceHash,
  type ProductTranslationSource } from "@/lib/domain/products/translation-policy";
import { DEFAULT_RUNTIME_SETTINGS } from "@/lib/operations/runtime-settings-schema";
import type { ProductTranslationLocale } from "@/lib/db/schema";

type Candidate = { id: number; name: string; tagline: string; description: string; locale: ProductTranslationLocale; field: "tagline";
  source_hash: string; source_locale: string | null; status: string; model: string; text: string | null; error_code: string | null };
type Checker = typeof checkProductTranslation;

const [mode, a, b, c, d] = process.argv.slice(2);
const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const source = (row: { id: number; name: string; tagline: string; description: string }): ProductTranslationSource =>
  ({ id: row.id, name: row.name, tagline: row.tagline, description: row.description });

async function main() {
  if (mode === "build") {
    const model = c, [en, hans, ja] = d.split(",").map(Number);
    const want: Record<string, number> = { en, "zh-Hans": hans, ja };
    const rows: Candidate[] = JSON.parse(readFileSync(a, "utf8"));
    const policy = DEFAULT_RUNTIME_SETTINGS.translation.product;
    const cases: Record<string, unknown>[] = [];
    const skipped: { id: number; locale: string; reason: string }[] = [];
    for (const locale of ["en", "zh-Hans", "ja"] as const) {
      // 운영 행의 source_hash 가 지금 원문과 같은 것만 — 저장된 결과가 이 원문의 번역이어야 견줄 수 있다
      const queue = rows.filter(row => row.locale === locale).filter(row => {
        const ok = productTranslationSourceHash(source(row), "tagline") === row.source_hash;
        if (!ok) skipped.push({ id: row.id, locale, reason: "source_hash_mismatch" });
        return ok;
      }).map(row => ({ row, source: source(row), field: "tagline" as const }));
      for (let made = 0; made < want[locale] && queue.length; made++) {
        const batch = packProductTranslationBatch(queue, policy);
        queue.splice(0, batch.length);
        const items = batch.map(task => ({ name: task.source.name, locale, field: "tagline" as const, text: task.source.tagline }));
        cases.push({ i: cases.length, task: "translate", locale, items,
          prod: batch.map(task => ({ productId: task.row.id, status: task.row.status, model: task.row.model, text: task.row.text,
            error: task.row.error_code, sourceLocale: task.row.source_locale })),
          wire: productTranslationGatewayWire(items, model) });
      }
    }
    writeFileSync(b, cases.map(row => JSON.stringify(row)).join("\n") + "\n");
    console.log(JSON.stringify({ cases: cases.length, skipped }));
    return;
  }
  if (mode === "check") {
    let pr986: Checker | null = null;
    if (d === "pr986") pr986 = (await import("@/lib/domain/products/translation-policy-pr986" as string) as { checkProductTranslation: Checker }).checkProductTranslation;
    const cases = new Map(lines(a).map(row => [row.i as number, row]));
    const out: string[] = [];
    for (const response of lines(b)) {
      const item = cases.get(response.i);
      if (!item) continue;
      const items = item.items as { name: string; locale: ProductTranslationLocale; field: "tagline"; text: string }[];
      const parsed = response.error ? { ok: false as const, error: String(response.error) }
        : parseKoreanTaglines(response.content ?? "", items.length, items);
      items.forEach((entry, index) => {
        const prod = item.prod[index];
        const src: ProductTranslationSource = { id: prod.productId, name: entry.name, tagline: entry.text };
        const output = parsed.ok ? parsed.outputs[index] : null;
        const checked = output === null ? null : checkProductTranslation(output, src, entry.locale, "tagline");
        const checked986 = output === null || !pr986 ? null : pr986(output, src, entry.locale, "tagline");
        // 운영에 저장된 번역도 같은 검사로 — failed 행은 글이 남지 않으므로 운영 오류 코드를 그대로 쓴다
        const prodChecked = prod.text ? checkProductTranslation(prod.text, src, entry.locale, "tagline") : null;
        const prodChecked986 = prod.text && pr986 ? pr986(prod.text, src, entry.locale, "tagline") : null;
        out.push(JSON.stringify({ i: item.i, index, locale: entry.locale, productId: prod.productId, name: entry.name, source: entry.text,
          batchError: parsed.ok ? null : parsed.error, output,
          ok: checked?.ok ?? false, reason: checked ? (checked.ok ? null : checked.reason) : (parsed.ok ? null : parsed.error),
          ok986: checked986 ? checked986.ok : null, reason986: checked986 && !checked986.ok ? checked986.reason : null,
          prodStatus: prod.status, prodModel: prod.model, prodText: prod.text, prodError: prod.error,
          prodOk: prodChecked ? prodChecked.ok : false, prodReason: prodChecked ? (prodChecked.ok ? null : prodChecked.reason) : prod.error,
          prodOk986: prodChecked986 ? prodChecked986.ok : null,
          ms: response.ms, usage: response.usage ?? null, finish: response.finish ?? null }));
      });
    }
    writeFileSync(c, out.join("\n") + "\n");
    return;
  }
  throw new Error("usage: build|check");
}
void main();
