import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, like, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, operationsObservations } from "@/lib/db/schema";
import { readJobDegraded } from "@/lib/operations/job-health";
import { runJob, getJobState, listJobStates } from "@/lib/jobs/runner";
import { JOBS } from "@/lib/jobs/registry";
import { ensureSchema } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(jobs);
});

describe("runJob — 커서 재개", () => {
  it("다음 틱이 지난 틱의 커서를 이어받는다", async () => {
    const seen: (number | null)[] = [];
    const tick = () =>
      runJob<{ page: number }>("resume-test", async (ctx) => {
        seen.push(ctx.cursor?.page ?? null);
        return { done: false, cursor: { page: (ctx.cursor?.page ?? 0) + 1 } };
      });

    await tick();
    await tick();
    await tick();

    expect(seen).toEqual([null, 1, 2]);
    expect((await getJobState("resume-test"))?.cursor).toEqual({ page: 3 });
  });

  it("done이면 커서를 비워 다음 사이클이 처음부터 시작한다", async () => {
    await runJob("cycle", async () => ({ done: false, cursor: { page: 7 } }));
    expect((await getJobState("cycle"))?.cursor).toEqual({ page: 7 });

    await runJob("cycle", async () => ({ done: true }));
    expect((await getJobState("cycle"))?.cursor).toBeNull();
  });

  it("save()로 저장한 지점은 중간에 실패해도 남는다", async () => {
    // 작업이 3개 중 2개를 처리하고 죽는 상황
    await runJob<{ processed: number }>("crash", async (ctx) => {
      await ctx.save({ processed: 1 });
      await ctx.save({ processed: 2 });
      throw new Error("여기서 죽음");
    });

    const state = await getJobState("crash");
    expect(state?.cursor).toEqual({ processed: 2 });
    expect(state?.lastError).toContain("여기서 죽음");
    // 실패는 성공 시각을 갱신하지 않는다
    expect(state?.lastSuccessAt).toBeNull();
  });
});

describe("runJob — 동시 실행 방지", () => {
  it("이미 실행 중이면 건너뛴다", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => (release = r));
    let secondRan = false;

    const first = runJob("lock-test", async () => {
      await blocked;
      return { done: true };
    });

    // 첫 실행이 잠금을 쥐고 있는 동안 두 번째 시도
    await new Promise((r) => setTimeout(r, 50));
    const second = await runJob("lock-test", async () => {
      secondRan = true;
      return { done: true };
    });

    expect(second).toEqual({ status: "skipped", reason: "locked" });
    expect(secondRan).toBe(false);

    release();
    await first;
  });

  it("실행이 끝나면 다음 틱이 다시 가져간다", async () => {
    await runJob("lock-release", async () => ({ done: true }));
    const again = await runJob("lock-release", async () => ({ done: true }));
    expect(again.status).toBe("completed");
  });

  it("죽은 프로세스가 남긴 오래된 잠금은 회수한다", async () => {
    await runJob("stale", async () => ({ done: true }));
    // 20분 전에 잠긴 것으로 위조 — 프로세스가 죽어 잠금만 남은 상황
    await db
      .update(jobs)
      .set({ lockedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(jobs.name, "stale"));

    const result = await runJob("stale", async () => ({ done: true }));
    expect(result.status).toBe("completed");
  });
});

describe("runJob — 시간 예산", () => {
  it("exposes the exact shared HTTP deadline including time spent claiming the job", async () => {
    const started = Date.now();
    let deadline: number | undefined;
    await runJob("shared-deadline", async ctx => {
      deadline = (ctx as { deadlineAt?: number }).deadlineAt;
      return { done: true };
    }, { budgetMs: 55_000 });
    expect(deadline).toBeGreaterThanOrEqual(started + 55_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 55_000);
  });

  it("예산을 넘기면 hasBudget이 false가 되어 작업이 물러난다", async () => {
    let loops = 0;
    const result = await runJob<{ n: number }>(
      "budget",
      async (ctx) => {
        while (ctx.hasBudget()) {
          loops++;
          await new Promise((r) => setTimeout(r, 10));
        }
        return { done: false, cursor: { n: loops } };
      },
      { budgetMs: 100 },
    );

    expect(result.status).toBe("completed");
    // 무한 루프가 아니라 예산 안에서 멈췄다
    expect(loops).toBeGreaterThan(0);
    expect(loops).toBeLessThan(50);
    expect((await getJobState("budget"))?.cursor).toEqual({ n: loops });
  });
});

describe("runJob — 실패 기록", () => {
  it("실패해도 커서를 건드리지 않아 다음 틱이 같은 지점에서 재시도한다", async () => {
    await runJob("retry-point", async () => ({ done: false, cursor: { page: 5 } }));

    await runJob("retry-point", async () => {
      throw new Error("일시적 장애");
    });

    const state = await getJobState("retry-point");
    expect(state?.cursor).toEqual({ page: 5 });
    expect(state?.lastError).toContain("일시적 장애");
  });

  it("성공하면 이전 실패 기록을 지운다", async () => {
    await runJob("recover", async () => {
      throw new Error("장애");
    });
    expect((await getJobState("recover"))?.lastError).toBeTruthy();

    await runJob("recover", async () => ({ done: true }));
    const state = await getJobState("recover");
    expect(state?.lastError).toBeNull();
    expect(state?.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("실패하면 30초 뒤 재시도로 미루고, 성공하면 그 유예를 지운다", async () => {
    await runJob("backoff", async () => {
      throw new Error("장애");
    });
    const failed = await getJobState("backoff");
    expect(failed?.notBefore!.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(failed?.notBefore!.getTime()).toBeLessThan(Date.now() + 40_000);

    await runJob("backoff", async () => ({ done: true }));
    expect((await getJobState("backoff"))?.notBefore).toBeNull();
  });

  it("실행 횟수를 센다 (스케줄이 도는지 확인하는 근거)", async () => {
    for (let i = 0; i < 3; i++) await runJob("counted", async () => ({ done: true }));
    expect((await getJobState("counted"))?.runs).toBe(3);
  });
});

/**
 * 처리기가 실패를 잡고 그냥 돌아오면 러너는 그 틱을 성공으로 적었다(lastSuccessAt=now, lastError=null) — 운영센터가 초록이었다.
 * 이제 처리기는 degraded 로 돌려주고, 러너는 요청·커서·잠금은 성공처럼 정리하되 성공 시각을 옮기지 않고 job:<name> 에 까닭·연속 횟수를 남긴다.
 */
describe("runJob — 제 일 못 한 틱(degraded)", () => {
  beforeEach(async () => {
    await db.delete(operationsObservations).where(or(like(operationsObservations.key, "job:%"), like(operationsObservations.key, "job-tally:%")));
  });
  const observation = async (name: string) => (await db.select().from(operationsObservations).where(eq(operationsObservations.key, `job:${name}`)))[0]?.value;

  it("성공 시각을 옮기지 않고 요청·커서·잠금은 정리한다 — 까닭과 연속 횟수·시작 시각을 남긴다", async () => {
    const result = await runJob("degraded-tick", async () => ({ done: false, cursor: { page: 2 }, degraded: { code: "search_failed", detail: "HN 검색 http_503" } }));
    expect(result).toMatchObject({ status: "completed", done: false, degraded: "search_failed" });
    const first = await getJobState("degraded-tick");
    expect(first).toMatchObject({ lastSuccessAt: null, lastError: null, lockedAt: null, leaseToken: null, notBefore: null, cursor: { page: 2 } });
    expect(first!.processedVersion).toBe(first!.requestedVersion);
    const one = readJobDegraded(await observation("degraded-tick")).current!;
    expect(one).toMatchObject({ code: "search_failed", detail: "HN 검색 http_503", critical: false, streak: 1 });
    expect(one.since).toBe(one.at);

    // 연달아 못 하면 횟수를 더하고 시작 시각은 첫 틱 그대로다. 모양이 틀린 코드는 unknown, 설명은 300자까지
    await runJob("degraded-tick", async () => ({ done: false, degraded: { code: "Bad Code!", detail: "x".repeat(400) } }));
    const two = readJobDegraded(await observation("degraded-tick")).current!;
    expect(two).toMatchObject({ code: "unknown", streak: 2, since: one.since });
    expect(two.detail).toHaveLength(300);
    expect((await getJobState("degraded-tick"))?.lastSuccessAt).toBeNull();
  });

  it("제대로 끝난 틱이 연속을 끊고 마지막 까닭은 lastDegraded 로 남긴다 — 그 뒤 못 한 틱은 지난 성공 시각을 그대로 둔다", async () => {
    await runJob("degraded-recover", async () => ({ done: true, degraded: { code: "no_key", detail: "키 없음", critical: true } }));
    await runJob("degraded-recover", async () => ({ done: true }));
    const recovered = await getJobState("degraded-recover");
    expect(recovered?.lastSuccessAt).toBeInstanceOf(Date);
    const value = await observation("degraded-recover");
    expect(readJobDegraded(value)).toMatchObject({ current: null, last: { code: "no_key", critical: true, streak: 1 } });
    await runJob("degraded-recover", async () => ({ done: true }));
    expect(readJobDegraded(await observation("degraded-recover")).last).toMatchObject({ code: "no_key" });
    const success = (await getJobState("degraded-recover"))?.lastSuccessAt;

    await runJob("degraded-recover", async () => ({ done: true, degraded: { code: "search_failed" } }));
    const again = await getJobState("degraded-recover");
    expect(again?.lastSuccessAt?.getTime()).toBe(success?.getTime());
    // 끊긴 뒤 처음이라 다시 1부터
    expect(readJobDegraded(await observation("degraded-recover")).current).toMatchObject({ code: "search_failed", streak: 1 });
  });

  it("던진 실패 뒤의 못 한 틱은 던진 실패 기록을 지우지만 성공으로 세지 않는다", async () => {
    await runJob("degraded-after-throw", async () => { throw new Error("장애"); });
    await runJob("degraded-after-throw", async () => ({ done: true, degraded: { code: "embedding_unavailable" } }));
    expect(await getJobState("degraded-after-throw")).toMatchObject({ lastError: null, lastSuccessAt: null, notBefore: null });
  });

  it("관리자 /admin/talk 의 수집 줄은 진짜 성공과 지금 이어지는 실패·끝난 실패를 읽는다", async () => {
    const { hnTalkJobState } = await import("@/lib/social/admin");
    await runJob("hn-talk", async () => ({ done: false, degraded: { code: "search_failed", detail: "HN 검색 http_503 (1쪽)" } }));
    expect(await hnTalkJobState()).toMatchObject({ lastSuccessAt: null, lastError: null, lastRunAt: expect.any(Date),
      degraded: { code: "search_failed", detail: "HN 검색 http_503 (1쪽)", streak: 1 } });
    await runJob("hn-talk", async () => ({ done: true }));
    expect(await hnTalkJobState()).toMatchObject({ lastSuccessAt: expect.any(Date), degraded: null, lastDegraded: { code: "search_failed" } });
  });

  it("수집기 회차 누적에 @ok 와 함께 @degraded 를 센다", async () => {
    await runJob("hn-talk", async (ctx) => { ctx.log("social.hn_talk_failed", { page: 0 }); return { done: false, degraded: { code: "search_failed" } }; }, { tally: true });
    await runJob("hn-talk", async () => ({ done: true }), { tally: true });
    const [row] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, "job-tally:hn-talk"));
    const counts = (row.value as { counts: Record<string, number> }).counts;
    const total = (metric: string) => Object.entries(counts).filter(([key]) => key.startsWith("h") && key.endsWith(`|${metric}`)).reduce((sum, [, n]) => sum + n, 0);
    expect([total("@ok"), total("@degraded")]).toEqual([2, 1]);
  });
});

/**
 * 사람이 멈춘 작업은 not_before 를 먼 미래(2100-01-01)로 민다(lib/jobs/status.ts). 소개 검수는 한 틱이
 * 110초라 도는 중에 멈추기 쉽다 — 그 틱이 끝나며 not_before 를 지우거나 30초로 덮으면 멈춘 작업이 저절로 다시 돈다.
 */
describe("runJob — 사람이 멈춘 작업", () => {
  const PAUSED = new Date("2100-01-01T00:00:00.000Z");
  const pauseWhileRunning = (name: string) => db.update(jobs).set({ notBefore: PAUSED }).where(eq(jobs.name, name));

  it("도는 중에 멈추면 성공한 틱이 멈춤을 지우지 않는다", async () => {
    await runJob("paused-ok", async () => {
      await pauseWhileRunning("paused-ok");
      return { done: true };
    });
    expect((await getJobState("paused-ok"))?.notBefore).toEqual(PAUSED);
  });

  it("도는 중에 멈추면 실패한 틱이 멈춤을 30초 재시도로 덮지 않는다", async () => {
    await runJob("paused-failed", async () => {
      await pauseWhileRunning("paused-failed");
      throw new Error("장애");
    });
    expect((await getJobState("paused-failed"))?.notBefore).toEqual(PAUSED);
  });
});

describe("listJobStates — 현황 화면이 읽는 것", () => {
  it("registers the bounded product evidence refresh job", () => {
    expect(JOBS["product-evidence-refresh"]).toBeTypeOf("function");
  });

  it("한 번도 안 돈 작업은 행이 없다", async () => {
    // 화면이 "실행 기록 없음"과 "돌다 실패함"을 갈라 보여줘야 하므로 여기서 채우지 않는다
    expect(await listJobStates()).toEqual([]);
  });

  it("돌아본 작업만 이름순으로 준다", async () => {
    await runJob("zzz-later", async () => ({ done: true }));
    await runJob("aaa-first", async () => {
      throw new Error("장애");
    });

    const states = await listJobStates();

    expect(states.map((s) => s.name)).toEqual(["aaa-first", "zzz-later"]);
    expect(states[0].lastError).toContain("장애");
    expect(states[1].lastSuccessAt).toBeInstanceOf(Date);
  });
});

describe("배포 — 멈추라는 신호와 남은 잠금", () => {
  it("신호를 받으면 진행 중인 일을 끊고 잠금을 놓고 나간다", async () => {
    const stopping = new AbortController();
    let finished = false;
    const run = runJob("shutdown-test", async (ctx) => {
      // 바깥을 오래 기다리는 일 — 신호가 오면 즉시 끝난다
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) return resolve();
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 10_000).unref();
      });
      finished = true;
      return { done: false };
    }, { budgetMs: 110_000, signal: stopping.signal });

    await new Promise((resolve) => setTimeout(resolve, 150));
    stopping.abort();
    const result = await run;

    expect(result.status).toBe("completed");
    expect(finished).toBe(true);
    // 잠금을 놓았다 — 다음 컨테이너가 곧바로 집을 수 있다
    const state = await getJobState("shutdown-test");
    expect(state?.lockedAt).toBeNull();
    expect(state?.leaseToken).toBeNull();
    expect(await runJob("shutdown-test", async () => ({ done: true }))).toMatchObject({ status: "completed" });
  });

  it("주인이 사라져 남은 잠금은 90초가 지나면 넘겨받는다", async () => {
    await runJob("stale-lock", async () => ({ done: false }));
    // 심장 박동이 끊긴 주인 — 30초 전이면 아직 살아 있는 것으로 본다
    const hold = async (secondsAgo: number) => db.update(jobs)
      .set({ lockedAt: new Date(Date.now() - secondsAgo * 1_000), leaseToken: "dead-worker" })
      .where(eq(jobs.name, "stale-lock"));

    await hold(30);
    expect(await runJob("stale-lock", async () => ({ done: true }))).toMatchObject({ status: "skipped", reason: "locked" });

    await hold(120);
    expect(await runJob("stale-lock", async () => ({ done: true }))).toMatchObject({ status: "completed" });
  });
});
