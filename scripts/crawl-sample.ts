/**
 * 판정 기준을 실데이터로 시험하기 위한 표본 수집기.
 *   npm run crawl:sample -- --pages=6
 *
 * GitHub 검색으로 레포를 모아 판정에 필요한 원본(레포 메타 + 배포 URL 응답 코드)만 파일로
 * 남긴다. 판정은 하지 않는다 — 원본과 판정을 나눠 두면 기준을 바꿀 때마다 GitHub을 다시
 * 긁지 않고 `npm run crawl:rejudge`로 다시 잴 수 있다. crawl_documents가 DB에서 하는 일과
 * 같은 이유이고, 이쪽은 DB 없이 손으로 돌리는 판이다.
 *
 * 표본이 바뀌면 기준을 바꾼 효과와 표본이 바뀐 효과가 섞여 비교가 안 된다. 그래서 파일로
 * 고정한다.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { normalizeUrl } from "@/lib/net/normalize";

/** 파일에 남기는 것 — 판정 함수가 받는 입력 그대로다 */
export type RawSample = {
  repo: string;
  /** 배포 URL 응답 코드. null이면 확인 실패(타임아웃·DNS 등) */
  status: number | null;
  meta: Record<string, unknown>;
};

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [key, value] = a.replace(/^--/, "").split("=");
    return [key, value ?? "true"] as const;
  }),
);
const PAGES = Number(args.get("pages") ?? 3);
const OUT = args.get("out") ?? ".crawl-samples/sample.json";

function githubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    console.error("GitHub 토큰이 없다. GITHUB_TOKEN을 넣거나 gh auth login을 먼저 한다.");
    process.exit(1);
  }
}
const TOKEN = githubToken();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 검색은 분당 한도(30회)와 별개로 2차 제한에 걸려 403을 준다.
 * 재시도 없이 던지면 표본을 절반만 뜬 채로 끝난다.
 */
async function gh<T>(apiPath: string, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.github.com${apiPath}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (res.ok) return (await res.json()) as T;
    if ((res.status === 403 || res.status === 429) && attempt < tries) {
      const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || attempt * 15_000;
      console.log(`  ${res.status} — ${wait / 1000}초 대기 후 재시도 (${attempt}/${tries})`);
      await sleep(wait);
      continue;
    }
    throw new Error(`GitHub ${res.status}: ${apiPath}`);
  }
}

/** 동시 실행 수를 묶은 map — 레포 메타와 생존 확인이 수백 건이라 한 번에 다 던질 수 없다 */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
}

async function main() {
  const { discover } = DEFAULT_CRAWL_SETTINGS;
  /**
   * 신호를 골라 뜰 수 있어야 한다. 신호별 수율을 비교하려면 같은 방법으로 각각 떠서
   * 같은 기준으로 판정해봐야 하는데, 켜져 있는 것만 쓰면 한쪽밖에 못 본다.
   */
  const wanted = args.get("signal");
  const signal = wanted
    ? (discover.queries.find((q) => q.label === wanted) ??
      (() => {
        console.error(`모르는 신호: ${wanted}. 있는 것: ${discover.queries.map((q) => q.label).join(", ")}`);
        process.exit(1);
      })())
    : (discover.queries.find((q) => q.enabled) ?? discover.queries[0]);
  console.log(`신호: ${signal.label} (${signal.query})`);
  const since = new Date(Date.now() - discover.windowDays * 86_400_000).toISOString().slice(0, 10);
  const query = `${signal.query} committer-date:>=${since}`;

  const repos = new Set<string>();
  for (let page = 1; page <= PAGES; page++) {
    const result = await gh<{ items?: { repository: { full_name: string } }[] }>(
      `/search/commits?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
    );
    for (const item of result.items ?? []) repos.add(item.repository.full_name);
    console.log(`검색 ${page}/${PAGES} — 누적 고유 레포 ${repos.size}개`);
    if (!result.items?.length) break;
    await sleep(4_000);
  }

  const metas = await pooled([...repos], 8, async (repo) => {
    try {
      return { repo, meta: await gh<Record<string, unknown>>(`/repos/${repo}`) };
    } catch {
      return null; // 표본 수집 중 사라진 레포는 그냥 뺀다
    }
  });
  const found = metas.filter((m): m is { repo: string; meta: Record<string, unknown> } => m !== null);
  console.log(`메타 ${found.length}/${repos.size}`);

  /**
   * homepage가 있으면 전부 생존 확인한다.
   * 판정이 status 게이트까지 오는 집합은 기준에 따라 달라지므로, 필요한 것만 받으면
   * 기준을 바꿔 재판정할 때 원본이 모자란다.
   */
  const targets = found
    .map((f) => ({ ...f, url: f.meta.homepage ? normalizeUrl(String(f.meta.homepage)) : null }))
    .filter((f): f is { repo: string; meta: Record<string, unknown>; url: string } => f.url !== null);
  console.log(`배포 URL ${targets.length}개 생존 확인 중`);

  const statuses = new Map<string, number | null>();
  await pooled(targets, 8, async ({ repo, url }) => {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
      statuses.set(repo, res.status);
    } catch {
      statuses.set(repo, null);
    }
  });

  const samples: RawSample[] = found.map(({ repo, meta }) => ({
    repo,
    status: statuses.get(repo) ?? null,
    meta,
  }));
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(samples, null, 2));
  console.log(`\n원본 ${samples.length}개 저장: ${OUT}`);
  console.log(`판정: npm run crawl:rejudge -- --in=${OUT}`);
}

void main();
