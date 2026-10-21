import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseXQueryRequest, parseXQueryResponse, signXQuery, utcDay, X_QUERY_MAX_REPOSITORIES } from "@/lib/operations/x-query";
import { signXPosts } from "@/lib/operations/x-posts";
import { X_STATUS_PREVIOUS_SECRET_ENV, X_STATUS_SECRET_ENV } from "@/lib/operations/x-status";
import { runXPilot, X_QUERY_MAX_LENGTH, xSearchQuery } from "@/lib/social/x-pilot";
import {
  planXQueryRepositories, repositoryTerm, xRepositoryQuery, X_QUERY_RECENT_DAYS, X_QUERY_ROTATION_CHARS, type XQueryCandidate,
} from "@/lib/social/x-query";

vi.mock("@/lib/db", () => ({ db: {}, onReplica: (load: () => unknown) => load() }));
const { verifyXQueryRequest } = await import("@/lib/operations/x-query-receive");

/*
 * 2026-10-21: X 검색어를 우리 공개 제품 저장소로 — 검색어 만들기(512자), 웹이 고르는 오늘의 목록(차례·먼저 볼 것),
 * 묻기·답 형식, 받는 쪽의 DB 앞 검사. 실제 SQL(공개 제품 고르기·차례 줄)은 tests/integration/x-query-route.test.ts 가 본다.
 */
const NOW = Date.parse("2026-10-21T00:10:05Z"), NOW_S = Math.floor(NOW / 1000), DAY = utcDay(NOW_S);
const repo = (index: number) => `owner${index}/repository-${index}`;
const candidate = (id: number, patch: Partial<XQueryCandidate> = {}): XQueryCandidate =>
  ({ id, repository: repo(id), listedAt: NOW - 400 * 86_400_000, gain: null, ...patch });
const joined = (keys: string[]) => keys.map(repositoryTerm).join(" OR ").length;

describe("검색어 만들기", () => {
  it("저장소마다 url:\"github.com/owner/repo\" 를 OR 로 잇고, 감싼 검색어가 512자를 넘지 않게 앞에서부터 담는다", () => {
    expect(xRepositoryQuery(["acme/tool", "vercel/next.js"])).toEqual({
      query: 'url:"github.com/acme/tool" OR url:"github.com/vercel/next.js"', repositories: ["acme/tool", "vercel/next.js"] });
    const many = Array.from({ length: 60 }, (_, index) => repo(index));
    const built = xRepositoryQuery(many)!;
    expect(xSearchQuery(built.query).length).toBeLessThanOrEqual(X_QUERY_MAX_LENGTH);
    expect(built.repositories).toEqual(many.slice(0, built.repositories.length));
    // 하나만 더 담으면 넘는다
    expect(xSearchQuery(`${built.query} OR ${repositoryTerm(many[built.repositories.length])}`).length).toBeGreaterThan(X_QUERY_MAX_LENGTH);
  });

  it("들지 않는 긴 이름은 건너뛰고 뒤의 짧은 이름을 담는다 — 틀린 이름·겹친 이름·대문자는 넣지 않는다", () => {
    const long = `${"a".repeat(39)}/${"b".repeat(100)}`;
    const filler = Array.from({ length: 9 }, (_, index) => repo(index));
    const built = xRepositoryQuery([...filler, long, long, "a/b"])!;
    expect(built.repositories).toContain("a/b");
    expect(xSearchQuery(built.query).length).toBeLessThanOrEqual(X_QUERY_MAX_LENGTH);
    expect(xRepositoryQuery(["Acme/Tool", "acme/..", "-bad/x", "acme/tool\"", "acme/a b", "acme/tool", "acme/tool"])?.repositories).toEqual(["acme/tool"]);
    expect(xRepositoryQuery([])).toBeNull();
  });

  it("만든 검색어는 수집기의 계획 검사(runXPilot, 512자 한 곳)를 지난다", async () => {
    const built = xRepositoryQuery(Array.from({ length: 40 }, (_, index) => `${"o".repeat(20)}${index}/${"r".repeat(18)}`))!;
    const plan = await runXPilot({ query: built.query, searchOnly: true, sortOrder: "relevancy" }, { now: () => NOW });
    expect(plan).toMatchObject({ status: "planned", plan: { query: xSearchQuery(built.query) } });
    expect(plan.plan!.query.length).toBeLessThanOrEqual(X_QUERY_MAX_LENGTH);
  });
});

describe("오늘의 목록 — 차례와 먼저 볼 것", () => {
  it("차례는 지난번 마지막 id 다음부터 160자만큼, 끝에 닿으면 처음으로 돈다", () => {
    const all = Array.from({ length: 10 }, (_, index) => candidate(index + 1));
    const first = planXQueryRepositories(all, { now: NOW, after: 0 });
    const perDay = first.repositories.length;
    expect(joined(first.repositories)).toBeLessThanOrEqual(X_QUERY_ROTATION_CHARS);
    expect(first).toEqual({ repositories: all.slice(0, perDay).map(item => item.repository), next: perDay });
    const wrapped = planXQueryRepositories(all, { now: NOW, after: 9 });
    expect(wrapped.repositories[0]).toBe(repo(10));
    expect(wrapped.repositories.slice(1)).toEqual(all.slice(0, perDay - 1).map(item => item.repository));
    expect(wrapped.next).toBe(perDay - 1);
  });

  it("날마다 next 를 이어 가면 제품이 늘어도 모든 공개 제품을 한 바퀴에 빠짐없이 본다", () => {
    let all = Array.from({ length: 50 }, (_, index) => candidate(index * 3 + 1));
    const seen = new Set<string>();
    let after = 0;
    for (let day = 0; day < 40 && seen.size < all.length; day++) {
      if (day === 5) all = [...all, candidate(1_000), candidate(1_001)];
      const plan = planXQueryRepositories(all, { now: NOW, after });
      for (const key of plan.repositories) seen.add(key);
      after = plan.next;
    }
    expect([...seen].sort()).toEqual(all.map(item => item.repository).sort());
  });

  it("남은 자리는 스타가 느는 제품과 14일 안에 오른 제품을 번갈아 채운다 — 많아도 차례를 밀어내지 않는다", () => {
    const old = Array.from({ length: 30 }, (_, index) => candidate(index + 1));
    const rising = Array.from({ length: 30 }, (_, index) => candidate(100 + index, { gain: 100 - index }));
    const recent = Array.from({ length: 30 }, (_, index) => candidate(200 + index, { listedAt: NOW - index * 3_600_000 }));
    const stale = candidate(300, { listedAt: NOW - (X_QUERY_RECENT_DAYS + 1) * 86_400_000 });
    const plan = planXQueryRepositories([...rising, ...recent, ...old, stale], { now: NOW, after: 0 });
    const turn = planXQueryRepositories(old, { now: NOW, after: 0 }).repositories;
    expect(plan.repositories.slice(0, turn.length)).toEqual(turn);
    expect(plan.repositories.slice(turn.length, turn.length + 4)).toEqual([repo(100), repo(200), repo(101), repo(201)]);
    expect(plan.repositories).not.toContain(repo(300));
    expect(xSearchQuery(xRepositoryQuery(plan.repositories)!.query).length).toBeLessThanOrEqual(X_QUERY_MAX_LENGTH);
    expect(plan.repositories.length).toBeGreaterThanOrEqual(10);
  });

  it("같은 저장소의 제품이 둘이면 먼저 등록된 것 하나만 — 차례에도 먼저 볼 것에도 한 번만", () => {
    const plan = planXQueryRepositories([candidate(2, { repository: "acme/tool", gain: 5 }), candidate(1, { repository: "acme/tool" })], { now: NOW, after: 0 });
    expect(plan).toEqual({ repositories: ["acme/tool"], next: 1 });
    expect(planXQueryRepositories([], { now: NOW, after: 7 })).toEqual({ repositories: [], next: 7 });
  });
});

describe("묻기·답 형식", () => {
  it("묻기는 {v:1, day} 하나 — day 는 서명한 보낸 시각의 UTC 날짜다", () => {
    expect(parseXQueryRequest({ v: 1, day: DAY }, NOW_S)).toEqual({ v: 1, day: "2026-10-21" });
    for (const value of [{ v: 1, day: "2026-10-20" }, { v: 2, day: DAY }, { v: 1, day: DAY, extra: 1 }, { v: 1 }, [DAY], null])
      expect(parseXQueryRequest(value, NOW_S), JSON.stringify(value)).toBeNull();
  });

  it("답은 물은 날짜의 소문자 owner/repo 를 겹치지 않게 40곳까지 — 어긋나면 null", () => {
    expect(parseXQueryResponse({ v: 1, day: DAY, repositories: ["acme/tool"] }, DAY)).toEqual({ v: 1, day: DAY, repositories: ["acme/tool"] });
    expect(parseXQueryResponse({ v: 1, day: DAY, repositories: [] }, DAY)).toEqual({ v: 1, day: DAY, repositories: [] });
    for (const value of [
      { v: 1, day: "2026-10-20", repositories: [] }, { v: 1, day: DAY, repositories: ["Acme/Tool"] }, { v: 1, day: DAY, repositories: ["acme/tool", "acme/tool"] },
      { v: 1, day: DAY, repositories: ['acme/tool" OR from:x'] }, { v: 1, day: DAY, repositories: "acme/tool" }, { v: 1, day: DAY, repositories: [], note: "x" },
      { v: 1, day: DAY, repositories: Array.from({ length: X_QUERY_MAX_REPOSITORIES + 1 }, (_, index) => repo(index)) },
    ]) expect(parseXQueryResponse(value, DAY), JSON.stringify(value).slice(0, 80)).toBeNull();
  });
});

describe("묻기 받기 — DB 앞 검사", () => {
  const SECRET = "x-status-current-secret-0123456789abcdef", OLD = "x-status-previous-secret-0123456789abcdef";
  beforeEach(() => { vi.stubEnv(X_STATUS_SECRET_ENV, SECRET); vi.stubEnv(X_STATUS_PREVIOUS_SECRET_ENV, OLD); });
  afterEach(() => vi.unstubAllEnvs());
  function signed(body: unknown, options: { secret?: string; sign?: typeof signXQuery; timestamp?: number; type?: string } = {}) {
    const raw = JSON.stringify(body), timestamp = options.timestamp ?? NOW_S;
    return new Request("https://nomorevibe.test/api/ops/x-query", { method: "POST", body: raw, headers: {
      "content-type": options.type ?? "application/json", "x-nmv-timestamp": String(timestamp),
      "x-nmv-signature": (options.sign ?? signXQuery)(options.secret ?? SECRET, timestamp, raw) } });
  }
  const status = async (request: Request) => {
    const checked = await verifyXQueryRequest(request, NOW);
    return checked.ok ? 200 : checked.response.status;
  };

  it("비밀이 없으면 없는 주소(404)다 — 본문도 읽지 않는다", async () => {
    vi.stubEnv(X_STATUS_SECRET_ENV, "");
    const request = signed({ v: 1, day: DAY });
    expect(await status(request)).toBe(404);
    expect(request.bodyUsed).toBe(false);
  });

  it("지금 비밀과 직전 비밀로 서명한 묻기를 받는다", async () => {
    expect(await verifyXQueryRequest(signed({ v: 1, day: DAY }), NOW)).toMatchObject({ ok: true, value: { request: { day: DAY }, signedWith: "current" } });
    expect(await verifyXQueryRequest(signed({ v: 1, day: DAY }, { secret: OLD }), NOW)).toMatchObject({ ok: true, value: { signedWith: "previous" } });
  });

  it("게시물 보고의 서명·틀린 비밀·5분 밖 시각은 401, JSON 이 아니면 415, 날짜·칸이 틀리면 400", async () => {
    expect(await status(signed({ v: 1, day: DAY }, { sign: signXPosts }))).toBe(401);
    expect(await status(signed({ v: 1, day: DAY }, { secret: "wrong-secret-0123456789abcdef0123456789" }))).toBe(401);
    expect(await status(signed({ v: 1, day: DAY }, { timestamp: NOW_S - 301 }))).toBe(401);
    expect(await status(signed({ v: 1, day: DAY }, { type: "text/plain" }))).toBe(415);
    expect(await status(signed({ v: 1, day: "2026-10-20" }))).toBe(400);
    expect(await status(signed({ v: 1, day: DAY, repositories: [] }))).toBe(400);
    expect(await status(signed({ v: 1, day: DAY, pad: "x".repeat(300) }))).toBe(413);
  });
});
