/**
 * deepseek 품질 표본(2026-11-18) — 키워드 검수(product-search-verify) 입력·결과 파서.
 * 운영 판 ebd63092 의 profileEvidence·profileHash·searchVerifyGatewayWire·parseVerification 을 그대로 쓴다. 운영 DB·모델을 부르지 않는다.
 *
 * 실행(ebd63092 트리 폴더에서, tsconfig 경로 별칭 때문):
 *   tsx verify-cases.ts build <candidates.json> <cases.jsonl> <model> <perModel> <withRemovedPerModel>
 *   tsx verify-cases.ts parse <cases.jsonl> <responses.jsonl> <results.jsonl>
 * candidates.json: 읽기 전용 SQL 결과(제품 칸 + product_search_profiles 칸). responses.jsonl: run-serial.py 출력.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { profileEvidence, profileHash } from "@/lib/domain/products/search-profile";
import { searchVerifyGatewayWire, parseVerification } from "@/lib/domain/products/search-verify";

type Candidate = {
  id: number; slug: string; name: string; url: string; category: string; tagline: string; description: string;
  search_topics: string | null; search_page_text: string | null; search_readme: string | null; reviewer_note: string | null;
  keywords_en: string[]; keywords_ko: string[]; removed_keywords: string[]; verify_model: string; verified_at: string;
  source_hash: string; has_rm: boolean;
};

const [mode, a, b, c, d, e] = process.argv.slice(2);
const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

if (mode === "build") {
  const model = c, perModel = Number(d), withRemoved = Number(e);
  const rows: Candidate[] = JSON.parse(readFileSync(a, "utf8"));
  const picked: Record<string, unknown>[] = [];
  const skipped: { id: number; reason: string }[] = [];
  for (const verifier of [...new Set(rows.map(row => row.verify_model))].sort()) {
    const take = { true: withRemoved, false: perModel - withRemoved };
    for (const row of rows.filter(r => r.verify_model === verifier).sort((x, y) => x.id - y.id)) {
      const key = String(row.has_rm) as "true" | "false";
      if (take[key] <= 0) continue;
      const evidence = profileEvidence({ name: row.name, url: row.url, category: row.category, tagline: row.tagline,
        description: row.description, searchTopics: row.search_topics, searchPageText: row.search_page_text,
        searchReadme: row.search_readme }, row.reviewer_note);
      // 운영이 검수할 때 본 근거와 같은지: 저장된 source_hash 와 지금 다시 만든 근거의 해시가 같아야 쓴다
      if (profileHash(evidence) !== row.source_hash) { skipped.push({ id: row.id, reason: "source_hash_mismatch" }); continue; }
      const keywords = [...row.keywords_en, ...row.keywords_ko];
      picked.push({ i: picked.length, task: "verify", productId: row.id, slug: row.slug, name: row.name, prodModel: verifier,
        prodVerifiedAt: row.verified_at, keywords, keywordsEn: row.keywords_en, keywordsKo: row.keywords_ko,
        prodRemoved: row.removed_keywords, evidenceLevel: evidence.evidenceLevel, tagline: row.tagline,
        wire: searchVerifyGatewayWire({ evidence, keywords }, model) });
      take[key]--;
    }
  }
  writeFileSync(b, picked.map(row => JSON.stringify(row)).join("\n") + "\n");
  console.log(JSON.stringify({ picked: picked.length, skipped }));
} else if (mode === "parse") {
  const cases = new Map(lines(a).map(row => [row.i as number, row]));
  const out: string[] = [];
  for (const response of lines(b)) {
    const item = cases.get(response.i);
    if (!item) continue;
    let removed: string[] | null = null, error: string | null = response.error ?? null;
    if (!error) {
      try { removed = parseVerification(item.keywords, response.content ?? ""); } catch { error = "invalid_output"; }
    }
    let checks: unknown = null;
    try { checks = (JSON.parse(String(response.content ?? "").slice(String(response.content ?? "").indexOf("{"))) as { checks?: unknown }).checks ?? null; } catch { checks = null; }
    out.push(JSON.stringify({ i: item.i, productId: item.productId, slug: item.slug, prodModel: item.prodModel,
      keywords: item.keywords, prodRemoved: item.prodRemoved, dsRemoved: removed, error, ms: response.ms,
      usage: response.usage ?? null, finish: response.finish ?? null, checks }));
  }
  writeFileSync(c, out.join("\n") + "\n");
} else {
  throw new Error("usage: build|parse");
}
