import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  agentRepositoryObservations,
  agentRepositoryScans,
  crawlCandidates,
  crawlDocuments,
  crawlSettings,
  products,
  productUpdates,
  type ProductStatus,
} from "@/lib/db/schema";
import { saveSettings } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";
import { completedWindows, loadHomePulse } from "@/lib/domain/products/home-pulse";
import { ensureSchema, resetTables } from "./setup";

const DAY = 86_400_000;
const now = new Date();
const { asOf } = completedWindows(now);
const daysBefore = (days: number) => new Date(asOf.getTime() - days * DAY);

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlSettings);
});

/** 공개 제품 하나와 그 저장소 — 시각은 창 경계에서 하루 이상 떨어뜨린다(시간대 차이에 흔들리지 않게) */
async function product(slug: string, category: string, options: {
  status?: ProductStatus; listedAt?: Date; bornAt?: Date | null; stars?: number;
} = {}) {
  await db.insert(products).values({
    slug, url: `https://${slug}.example`, name: slug, tagline: "t", description: "d", category,
    status: options.status ?? "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64),
    createdAt: options.listedAt ?? daysBefore(30),
  });
  if (options.bornAt === null) return;
  const repo = `acme/${slug}`;
  await db.insert(crawlDocuments).values({ repo, repoMeta: {
    created_at: (options.bornAt ?? daysBefore(90)).toISOString(), stargazers_count: options.stars ?? 0,
  } });
  await db.insert(crawlCandidates).values({ repo, state: "published", publishedSlug: slug });
}

async function release(slug: string, publishedAt: Date, sourceKind: "github_release" | "feed" = "github_release") {
  await db.insert(productUpdates).values({
    slug, sourceKind, dedupeKey: `${slug}-${publishedAt.getTime()}-${Math.random()}`,
    title: "v1", publishedAt, observedAt: publishedAt,
  });
}

/** 저장소 흔적 조사 결과 — 집계는 facts.client 만 본다 */
async function scan(slug: string, clients: (string | null)[], completedAt = daysBefore(1)) {
  const [row] = await db.insert(agentRepositoryScans).values({
    githubRepositoryId: BigInt(Math.floor(Math.random() * 1e9)), repositoryKey: `acme/${slug}`, commitSha: "c".repeat(40),
    detectorVersion: "v", scopeHash: "s", state: "complete", completedAt,
  }).returning();
  for (const [index, client] of clients.entries()) {
    await db.insert(agentRepositoryObservations).values({
      scanId: row.id, observationKey: `k${index}`, facts: { kind: "instruction_file", client } as unknown as AgentObservation,
    });
  }
}

async function seed() {
  await product("fresh-dev", "Dev", { bornAt: daysBefore(2), listedAt: daysBefore(1), stars: 1500 });
  await product("fresh-games", "Games", { bornAt: daysBefore(3), listedAt: daysBefore(2) });
  await product("prev-dev", "Dev", { status: "verified", bornAt: daysBefore(10), listedAt: daysBefore(9), stars: 40 });
  await product("old-other", "Other", { bornAt: daysBefore(60) });
  await product("no-repo", "Dev", { bornAt: null });
  // 기준 시각(오늘 0시) 뒤에 오른 것과 차단된 것은 세지 않는다
  await product("today-dev", "Dev", { bornAt: daysBefore(2), listedAt: new Date(asOf.getTime() + DAY / 2) });
  await product("banned-dev", "Dev", { status: "banned", bornAt: daysBefore(2) });

  for (const day of [1, 2, 3]) await release("fresh-dev", daysBefore(day));
  await release("prev-dev", daysBefore(4));
  await release("prev-dev", daysBefore(10)); // 직전 주
  await release("old-other", daysBefore(2), "feed"); // 새 버전으로 세지 않는 출처
  await release("banned-dev", daysBefore(2));
}

describe("홈 윗줄·리더보드 집계", () => {
  it("태어난 프로젝트는 저장소를 처음 만든 날로, 기준 시각에 공개돼 있던 것만 센다", async () => {
    await seed();
    const pulse = await loadHomePulse(now);

    expect(pulse.born).toEqual({ current: 2, previous: 1, change: null });
    expect(pulse.total).toBe(5);
    expect(pulse.categories).toEqual([
      { key: "Dev", total: 3, born: 1 },
      { key: "Games", total: 1, born: 1 },
      { key: "Other", total: 1, born: 0 },
    ]);
  });

  it("새 버전은 끝난 7일의 릴리스만, 활발한 순서는 릴리스 수로 센다", async () => {
    await seed();
    const pulse = await loadHomePulse(now);

    expect(pulse.updates).toEqual({ projects: 2, releases: 4 });
    expect(pulse.active).toEqual([
      { slug: "fresh-dev", name: "fresh-dev", category: "Dev", releases: 3, stars: 1500 },
      { slug: "prev-dev", name: "prev-dev", category: "Dev", releases: 1, stars: 40 },
    ]);
  });

  it("제작 도구는 관찰 사실 공개가 켜져 있을 때만, 저장소마다 마지막 조사로 센다", async () => {
    await seed();
    await scan("fresh-dev", ["claude-code", "claude-code"]);
    await scan("prev-dev", ["codex"], daysBefore(20)); // 지난 조사 — 새 조사가 덮는다
    await scan("prev-dev", ["cursor", "claude-code"]);
    await scan("old-other", [null]);

    expect((await loadHomePulse(now)).tools).toBeNull();

    await saveSettings({ agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, displayObservedFacts: true } }, "test");
    expect((await loadHomePulse(now)).tools).toEqual({
      scanned: 3,
      withTool: 2,
      rows: [{ label: "Claude Code", count: 2 }, { label: "Cursor", count: 1 }],
    });
  });
});
