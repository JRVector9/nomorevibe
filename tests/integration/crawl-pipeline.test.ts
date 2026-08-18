import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlFrontier, crawlDocuments, crawlCandidates } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { ensureSchema } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
});

describe("프론티어 — 큐 채우기", () => {
  it("발견한 레포를 넣고 중복은 무시한다", async () => {
    const first = await crawl.enqueue([
      { repo: "a/one", signal: "commit-trailer" },
      { repo: "b/two", signal: "commit-trailer" },
    ]);
    expect(first).toBe(2);

    // 같은 레포가 다른 검색 결과에 또 나와도 한 번만 조사한다
    const second = await crawl.enqueue([
      { repo: "a/one", signal: "commit-trailer" },
      { repo: "c/three", signal: "commit-trailer" },
    ]);
    expect(second).toBe(1);
    expect(await crawl.frontierCounts()).toEqual({ pending: 3 });
  });

  it("빈 배열은 조회조차 하지 않는다", async () => {
    expect(await crawl.enqueue([])).toBe(0);
  });

  it("다 조사한 것도 다시 조사 대상으로 되돌린다", async () => {
    // 원본에서 뽑는 방법이 바뀌면(pageMeta 추출 로직) 다시 가져오는 수밖에 없다
    await crawl.enqueue([{ repo: "a/one", signal: "commit-trailer" }]);
    await crawl.dequeue(1);
    await crawl.markFrontier("a/one", "done");
    expect(await crawl.dequeue(1)).toEqual([]);

    expect(await crawl.requeue(["a/one"])).toBe(1);

    const [entry] = await crawl.dequeue(1);
    expect(entry?.repo).toBe("a/one");
    // 시도 횟수도 되돌린다 — 예전 실패 때문에 바로 소진되면 안 된다
    expect(entry?.attempts).toBe(1);
  });

  it("없는 레포를 되돌려도 아무 일도 없다", async () => {
    expect(await crawl.requeue(["없는/레포"])).toBe(0);
    expect(await crawl.requeue([])).toBe(0);
  });
});

describe("프론티어 — 꺼내기", () => {
  it("넣자마자 꺼낼 수 있다 — 시계 스큐에 걸리지 않는다", async () => {
    // next_attempt_at은 DB의 now()로 들어간다. 비교 기준을 클라이언트 시각으로 삼으면
    // 두 시계 차이(로컬 Docker에서 실측 20ms)만큼 방금 넣은 항목이 안 꺼내진다.
    await crawl.enqueue([{ repo: "a/one", signal: "s" }]);
    expect(await crawl.dequeue(1)).toHaveLength(1);
  });

  it("우선순위가 높은 것을 먼저 준다", async () => {
    await crawl.enqueue([
      { repo: "low/one", signal: "s", priority: 1 },
      { repo: "high/two", signal: "s", priority: 100 },
      { repo: "mid/three", signal: "s", priority: 50 },
    ]);

    const taken = await crawl.dequeue(2);
    expect(taken.map((t) => t.repo)).toEqual(["high/two", "mid/three"]);
  });

  it("꺼낸 항목은 fetching이 되고 시도 횟수가 오른다", async () => {
    await crawl.enqueue([{ repo: "a/one", signal: "s" }]);
    const [taken] = await crawl.dequeue(1);

    expect(taken.state).toBe("fetching");
    expect(taken.attempts).toBe(1);
  });

  it("이미 꺼낸 항목을 곧바로 다시 주지 않는다", async () => {
    await crawl.enqueue([{ repo: "a/one", signal: "s" }]);
    await crawl.dequeue(10);

    // 두 번째 워커가 같은 항목을 가져가면 GitHub 호출이 낭비된다
    expect(await crawl.dequeue(10)).toHaveLength(0);
  });

  it("가져오다 죽은 항목은 시간이 지나면 회수한다", async () => {
    await crawl.enqueue([{ repo: "a/one", signal: "s" }]);
    await crawl.dequeue(1);

    // 프로세스가 죽어 fetching인 채로 남은 상황
    const later = new Date(Date.now() + 20 * 60 * 1000);
    const recovered = await crawl.dequeue(1, later);

    expect(recovered.map((r) => r.repo)).toEqual(["a/one"]);
    expect(recovered[0].attempts).toBe(2);
  });

  it("동시에 꺼내도 같은 항목이 두 번 나가지 않는다", async () => {
    await crawl.enqueue(
      Array.from({ length: 20 }, (_, i) => ({ repo: `x/${i}`, signal: "s" })),
    );

    const [a, b, c] = await Promise.all([
      crawl.dequeue(10),
      crawl.dequeue(10),
      crawl.dequeue(10),
    ]);

    const all = [...a, ...b, ...c].map((r) => r.repo);
    expect(all).toHaveLength(new Set(all).size); // 중복 없음
    expect(all.length).toBeLessThanOrEqual(20);
  });
});

describe("프론티어 — 실패와 백오프", () => {
  it("일시적 실패는 미뤘다가 다시 시도한다", async () => {
    await crawl.enqueue([{ repo: "a/one", signal: "s" }]);
    await crawl.dequeue(1);

    const now = new Date();
    await crawl.markFailed("a/one", "rate limit", now);

    const entry = await db.query.crawlFrontier.findFirst({ where: eq(crawlFrontier.repo, "a/one") });
    expect(entry?.state).toBe("pending");
    expect(entry?.lastError).toContain("rate limit");
    // 곧바로 다시 꺼내지지 않는다
    expect(await crawl.dequeue(1, now)).toHaveLength(0);
    // 백오프가 지나면 꺼내진다
    expect(await crawl.dequeue(1, new Date(now.getTime() + 10 * 60_000))).toHaveLength(1);
  });

  it("재시도 한도를 소진하면 failed로 내려 큐를 막지 않는다", async () => {
    await crawl.enqueue([{ repo: "a/one", signal: "s" }]);

    // 기준 시각을 넉넉히 뒤로 잡는다. DB 시계가 호스트보다 앞설 수 있어
    // new Date()를 그대로 쓰면 방금 넣은 항목이 "아직 시간이 안 됐다"로 걸린다.
    let at = new Date(Date.now() + 60_000);
    for (let i = 0; i < crawl.MAX_ATTEMPTS; i++) {
      await crawl.dequeue(1, at);
      await crawl.markFailed("a/one", `실패 ${i}`, at);
      at = new Date(at.getTime() + 6 * 60 * 60_000);
    }

    const entry = await db.query.crawlFrontier.findFirst({ where: eq(crawlFrontier.repo, "a/one") });
    expect(entry?.state).toBe("failed");
    // 영원히 재시도하지 않는다
    expect(await crawl.dequeue(1, new Date(at.getTime() + 86_400_000))).toHaveLength(0);
  });

  it("성공하면 done, 값싼 거르기는 skipped로 남는다", async () => {
    await crawl.enqueue([{ repo: "a/one", signal: "s" }, { repo: "b/two", signal: "s" }]);
    await crawl.dequeue(2);

    await crawl.markFrontier("a/one", "done");
    await crawl.markFrontier("b/two", "skipped");

    expect(await crawl.frontierCounts()).toEqual({ done: 1, skipped: 1 });
  });
});

describe("원본 보관", () => {
  it("저장하고 다시 읽는다", async () => {
    await crawl.putDocument({
      repo: "a/one",
      repoMeta: { stargazers_count: 42, homepage: "https://one.test" },
      productUrl: "https://one.test",
      pageStatus: 200,
      pageMeta: { title: "One" },
    });

    const doc = await crawl.getDocument("a/one");
    expect(doc?.productUrl).toBe("https://one.test");
    expect((doc?.repoMeta as { stargazers_count: number }).stargazers_count).toBe(42);
  });

  it("다시 가져오면 덮어쓴다 (재방문 시 최신 상태)", async () => {
    await crawl.putDocument({ repo: "a/one", repoMeta: { stargazers_count: 1 }, pageStatus: 200 });
    await crawl.putDocument({ repo: "a/one", repoMeta: { stargazers_count: 999 }, pageStatus: 404 });

    const doc = await crawl.getDocument("a/one");
    expect((doc?.repoMeta as { stargazers_count: number }).stargazers_count).toBe(999);
    expect(doc?.pageStatus).toBe(404);
  });

  it("판정 안 된 원본만 골라준다", async () => {
    await crawl.putDocument({ repo: "a/judged", repoMeta: {} });
    await crawl.putDocument({ repo: "b/fresh", repoMeta: {} });
    await crawl.recordJudgement({
      repo: "a/judged",
      productUrl: null,
      state: "rejected",
      reason: "no_homepage",
      decidedBy: "auto",
    });

    const pending = await crawl.documentsAwaitingJudgement(10);
    expect(pending.map((d) => d.repo)).toEqual(["b/fresh"]);
  });

  it("판정을 new로 되돌리면 재판정 대상이 된다 (규칙을 바꿨을 때)", async () => {
    await crawl.putDocument({ repo: "a/one", repoMeta: {} });
    await crawl.recordJudgement({
      repo: "a/one",
      productUrl: null,
      state: "rejected",
      reason: "large_oss",
      decidedBy: "auto",
    });
    expect(await crawl.documentsAwaitingJudgement(10)).toHaveLength(0);

    await db.update(crawlCandidates).set({ state: "new" }).where(eq(crawlCandidates.repo, "a/one"));
    // GitHub을 다시 긁지 않고 재판정할 수 있다
    expect(await crawl.documentsAwaitingJudgement(10)).toHaveLength(1);
  });
});

describe("판정", () => {
  it("자동 판정 결과와 근거를 남긴다", async () => {
    await crawl.recordJudgement({
      repo: "a/one",
      productUrl: "https://one.test",
      state: "approved",
      reason: "passed",
      decidedBy: "auto",
      signals: { stars: 3, isFork: false },
    });

    const candidate = await crawl.getCandidate("a/one");
    expect(candidate?.state).toBe("approved");
    expect(candidate?.decidedBy).toBe("auto");
    expect(candidate?.judgedAt).toBeInstanceOf(Date);
    // 자동 판정은 사람의 결정 시각을 남기지 않는다
    expect(candidate?.decidedAt).toBeNull();
    expect(candidate?.signals).toEqual({ stars: 3, isFork: false });
  });

  it("사람이 뒤집으면 결정 시각이 남는다 — 규칙 품질의 지표다", async () => {
    await crawl.recordJudgement({
      repo: "a/one",
      productUrl: "https://one.test",
      state: "needs_review",
      reason: "ambiguous",
      decidedBy: "auto",
    });
    await crawl.recordJudgement({
      repo: "a/one",
      productUrl: "https://one.test",
      state: "approved",
      reason: "passed",
      decidedBy: "admin",
    });

    const candidate = await crawl.getCandidate("a/one");
    expect(candidate?.state).toBe("approved");
    expect(candidate?.decidedBy).toBe("admin");
    expect(candidate?.decidedAt).toBeInstanceOf(Date);
  });

  it("상태별로 골라 보여준다", async () => {
    for (const [repo, state, reason] of [
      ["a/ok", "approved", "passed"],
      ["b/no", "rejected", "large_oss"],
      ["c/hmm", "needs_review", "ambiguous"],
    ] as const) {
      await crawl.recordJudgement({ repo, productUrl: null, state, reason, decidedBy: "auto" });
    }

    const review = await crawl.listCandidates(["needs_review"], 10);
    expect(review.map((c) => c.repo)).toEqual(["c/hmm"]);

    const actionable = await crawl.listCandidates(["approved", "needs_review"], 10);
    expect(actionable).toHaveLength(2);
  });

  it("거부 사유별 집계 — 어떤 규칙이 얼마나 거르는지", async () => {
    for (const [repo, reason] of [
      ["a/1", "large_oss"],
      ["b/2", "large_oss"],
      ["c/3", "no_homepage"],
    ] as const) {
      await crawl.recordJudgement({ repo, productUrl: null, state: "rejected", reason, decidedBy: "auto" });
    }

    const breakdown = await crawl.rejectionBreakdown();
    expect(breakdown[0]).toEqual({ reason: "large_oss", count: 2 });
  });
});

describe("발행", () => {
  it("발행하면 slug를 기록하고 published가 된다", async () => {
    await crawl.recordJudgement({
      repo: "a/one",
      productUrl: "https://one.test",
      state: "approved",
      reason: "passed",
      decidedBy: "auto",
    });

    await crawl.markPublished("a/one", "one");

    const candidate = await crawl.getCandidate("a/one");
    expect(candidate?.state).toBe("published");
    expect(candidate?.publishedSlug).toBe("one");
    // 발행된 것은 다시 승인 대기 목록에 뜨지 않는다
    expect(await crawl.listCandidates(["approved"], 10)).toHaveLength(0);
  });

  it("파이프라인 전 구간의 현황을 셀 수 있다", async () => {
    await crawl.enqueue([{ repo: "a/one", signal: "s" }]);
    await crawl.recordJudgement({
      repo: "b/two",
      productUrl: null,
      state: "approved",
      reason: "passed",
      decidedBy: "auto",
    });

    expect(await crawl.frontierCounts()).toEqual({ pending: 1 });
    expect(await crawl.candidateCounts()).toEqual({ approved: 1 });
  });
});
