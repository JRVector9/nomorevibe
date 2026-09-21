/** Offline CPU measurement only: no env loading, DB, HTTP, or model calls.
 * Run from repository root with:
 * npx tsx docs/operations/evaluations/2026-09-21-crawl-checks/benchmark.ts
 */
import { performance } from "node:perf_hooks";
import { judge, factsFromRepoMeta, pageFactsFromDocument, judgeRevision, accessFromDocument } from "../../../../lib/crawl/rules";
import { DEFAULT_CRAWL_SETTINGS } from "../../../../lib/crawl/settings-schema";

const now = new Date("2026-09-21T02:10:13.362Z");
const base = {
  repo: "someone/my-app",
  repoMeta: { stargazers_count: 12, fork: false, archived: false,
    owner: { type: "User" }, pushed_at: "2026-09-20T00:00:00Z", description: "A tool for organizing tasks" },
  productUrl: "https://my-app.vercel.app" as string | null,
  pageStatus: 200 as number | null,
  pageMeta: { title: "Task Organizer", description: "Organize tasks and collaborate", textSample: "Create and organize your tasks." },
};
const cases = [
  { name: "live_website", document: base },
  { name: "missing_url_499", document: { ...base, repoMeta: { ...base.repoMeta, stargazers_count: 499 }, productUrl: null, pageStatus: null } },
  { name: "installable_500", document: { ...base, repoMeta: { ...base.repoMeta, stargazers_count: 500 }, productUrl: null, pageStatus: null } },
  { name: "fork", document: { ...base, repoMeta: { ...base.repoMeta, fork: true } } },
  { name: "archived", document: { ...base, repoMeta: { ...base.repoMeta, archived: true } } },
  { name: "docs_framework", document: { ...base, pageMeta: { ...base.pageMeta, generator: "docusaurus" } } },
  { name: "unknown_http", document: { ...base, pageStatus: null } },
  { name: "failed_homepage_500", document: { ...base, repoMeta: { ...base.repoMeta, stargazers_count: 500 }, pageStatus: 404 } },
  { name: "research_note", document: { ...base, pageMeta: { ...base.pageMeta, title: "My research notes" } } },
  { name: "long_page", document: { ...base, pageMeta: { ...base.pageMeta, textSample: "Create and organize your tasks. ".repeat(200).slice(0, 6000) } } },
];
const settings = DEFAULT_CRAWL_SETTINGS;
let consumed = 0;
function evaluate(document: typeof base, withPreparation: boolean) {
  const verdict = judge(factsFromRepoMeta(document.repo, document.repoMeta), pageFactsFromDocument(document), settings, now);
  consumed += verdict.trace.length;
  if (withPreparation) {
    consumed += judgeRevision(document).length;
    consumed += accessFromDocument(document, settings) ? 1 : 0;
  }
  return verdict;
}
const quantile = (values: number[], q: number) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * q) - 1];
function measure(withPreparation: boolean) {
  for (let warmup = 0; warmup < 100; warmup++) for (const item of cases) evaluate(item.document, withPreparation);
  const all: number[] = [];
  const perCase = cases.map(item => ({ name: item.name, durations: [] as number[] }));
  const start = performance.now();
  for (let round = 0; round < 5; round++) {
    for (let repeat = 0; repeat < 500; repeat++) {
      for (let index = 0; index < cases.length; index++) {
        const before = performance.now();
        evaluate(cases[index].document, withPreparation);
        const elapsed = performance.now() - before;
        all.push(elapsed);
        perCase[index].durations.push(elapsed);
      }
    }
  }
  const totalMs = performance.now() - start;
  return {
    calls: all.length, totalMs, p50Ms: quantile(all, .5), p95Ms: quantile(all, .95),
    perCase: perCase.map(item => ({ name: item.name, p50Ms: quantile(item.durations, .5), p95Ms: quantile(item.durations, .95) })),
  };
}
console.log(JSON.stringify({
  measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  scope: "10 constructed fixtures, repository default settings, fixed clock, warm local CPU. Not a production workload or an accuracy benchmark. No DB/HTTP/model/HTML parsing included.",
  method: "100 warmup passes; 5 rounds x 500 passes x 10 fixtures per mode; nearest-rank p50/p95 per-call ms",
  fixtures: cases.map(item => {
    const verdict = evaluate(item.document, false);
    return { name: item.name, state: verdict.state, reason: verdict.reason, cause: verdict.cause ?? null, checks: verdict.trace.length };
  }),
  rulesOnly: measure(false),
  rulesPlusRevisionAndAccess: measure(true),
  consumed,
}, null, 2));
