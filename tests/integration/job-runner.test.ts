import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
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

  it("실행 횟수를 센다 (스케줄이 도는지 확인하는 근거)", async () => {
    for (let i = 0; i < 3; i++) await runJob("counted", async () => ({ done: true }));
    expect((await getJobState("counted"))?.runs).toBe(3);
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
