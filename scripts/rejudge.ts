/**
 * 떠 놓은 표본에 현재 판정 규칙을 다시 돌린다.
 *   npm run crawl:rejudge
 *   npm run crawl:rejudge -- --in=.crawl-samples/sample.json --out=.crawl-samples/after.json
 *
 * 네트워크도 DB도 타지 않으므로 기준을 고칠 때마다 몇 초 만에 다시 잰다.
 * 기준을 고치기 전후로 한 번씩 돌려 `--out` 결과를 비교하면, 어떤 판정이 어떻게 바뀌었는지가
 * 숫자가 아니라 레포 이름으로 나온다 — 통과가 몇 개 줄었는지보다 무엇이 빠졌는지가 중요하다.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { judge, factsFromRepoMeta } from "@/lib/crawl/rules";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { normalizeUrl } from "@/lib/net/normalize";
import type { RawSample } from "./crawl-sample";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [key, value] = a.replace(/^--/, "").split("=");
    return [key, value ?? "true"] as const;
  }),
);
const IN = args.get("in") ?? ".crawl-samples/sample.json";
const OUT = args.get("out");

const samples: RawSample[] = JSON.parse(readFileSync(IN, "utf8"));
const now = new Date();

const rows = samples.map(({ repo, meta, status }) => {
  const productUrl = meta.homepage ? normalizeUrl(String(meta.homepage)) : null;
  const verdict = judge(factsFromRepoMeta(repo, meta), { productUrl, status }, DEFAULT_CRAWL_SETTINGS, now);
  return {
    repo,
    url: productUrl,
    stars: typeof meta.stargazers_count === "number" ? meta.stargazers_count : 0,
    status,
    state: verdict.state,
    reason: verdict.reason,
    description: typeof meta.description === "string" ? meta.description : null,
  };
});

const counts = new Map<string, number>();
for (const r of rows) {
  const key = `${r.state}/${r.reason}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

console.log(`표본 ${rows.length}개 (${IN})\n`);
for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(4)}  ${key}`);
}

// 통과와 보류는 눈으로 봐야 한다. 분포만 보면 잘못 통과한 것이 안 보인다
for (const state of ["approved", "needs_review"] as const) {
  const listed = rows.filter((r) => r.state === state);
  if (listed.length === 0) continue;
  console.log(`\n${state} ${listed.length}개`);
  for (const r of listed) {
    console.log(`  ${r.repo}  ★${r.stars}  ${r.url}`);
    if (r.description) console.log(`      ${r.description.slice(0, 80)}`);
  }
}

if (OUT) {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(rows, null, 2));
  console.log(`\n판정 결과 저장: ${OUT}`);
}
