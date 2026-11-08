import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: logs.info, warn: logs.warn, error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: {}, onPrimary: (run: () => unknown) => run() }));

import { retryOnLockNotAvailable, SETTLE_LOCK_RETRY_DELAYS_MS } from "@/lib/llm/capacity-lock-retry";

/** drizzle 은 PostgreSQL 오류를 cause 에 싣는다(DrizzleQueryError → postgres 오류) — 운영과 같은 모양 */
const lockTimeout = () => Object.assign(new Error('Failed query: select "id" from "model_capacity_control" where "model_capacity_control"."id" = $1 for update'),
  { cause: Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }) });

beforeEach(() => { vi.clearAllMocks(); });

describe("정산 TX 의 control 잠금 재시도(2026-11-08)", () => {
  it("55P03 이면 같은 TX 를 다시 열고, 잠금을 쥔 세션은 첫 실패 뒤 한 번만 읽는다", async () => {
    const run = vi.fn().mockRejectedValueOnce(lockTimeout()).mockRejectedValueOnce(lockTimeout()).mockResolvedValueOnce({ kind: "settled" });
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {}), holders = vi.fn(async () => [{ pid: 1, application: "nomorevibe:text", state: "idle in transaction", xactAgeMs: 6100, waiting: null }]);
    await expect(retryOnLockNotAvailable("reconcileSearchVerifyGatewayTerminal", run, { sleep, holders })).resolves.toEqual({ kind: "settled" });
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [1_000]]);
    expect(holders).toHaveBeenCalledTimes(1);
    expect(logs.warn).toHaveBeenNthCalledWith(1, "model_capacity.settle_lock_retry", expect.objectContaining({ settle: "reconcileSearchVerifyGatewayTerminal", attempt: 1,
      holders: [expect.objectContaining({ application: "nomorevibe:text", xactAgeMs: 6100 })] }));
    expect(logs.warn.mock.calls[1][1]).not.toHaveProperty("holders");
    expect(logs.info).toHaveBeenCalledWith("model_capacity.settle_lock_recovered", { settle: "reconcileSearchVerifyGatewayTerminal", attempts: 3 });
  });
  it("55P03 이 아닌 오류(정산 근거 불일치·연결 끊김 등)는 다시 열지 않고 그대로 던진다", async () => {
    const conflict = new Error("search_verify_gateway_terminal_conflict"), reset = Object.assign(new Error("write CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" });
    for (const error of [conflict, reset]) {
      const run = vi.fn().mockRejectedValue(error), sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
      await expect(retryOnLockNotAvailable("x", run, { sleep, holders: async () => [] })).rejects.toBe(error);
      expect(run).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
    }
    expect(logs.warn).not.toHaveBeenCalled();
  });
  it("간격을 다 쓰면 마지막 55P03 을 그대로 던진다 — 호출부가 그때 commit_unknown 으로 표시한다", async () => {
    const last = lockTimeout();
    const run = vi.fn().mockRejectedValueOnce(lockTimeout()).mockRejectedValueOnce(lockTimeout()).mockRejectedValueOnce(lockTimeout()).mockRejectedValueOnce(last);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    await expect(retryOnLockNotAvailable("x", run, { sleep, holders: async () => { throw new Error("diag down"); } })).rejects.toBe(last);
    expect(run).toHaveBeenCalledTimes(SETTLE_LOCK_RETRY_DELAYS_MS.length + 1);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...SETTLE_LOCK_RETRY_DELAYS_MS]);
    expect(logs.warn).toHaveBeenLastCalledWith("model_capacity.settle_lock_exhausted", { settle: "x", attempts: 4 });
    // 진단 읽기가 실패해도 재시도는 계속됐다(빈 목록으로 남긴다)
    expect(logs.warn.mock.calls[0][1]).toMatchObject({ attempt: 1, holders: [] });
  });
  it("모든 물리 종료 정산(reconcile*)과 미확정 표시가 재시도 TX 로 열린다 — 맨 transaction( 으로 여는 정산 함수가 없다", () => {
    const source = readFileSync("lib/llm/capacity-repository.ts", "utf8");
    const starts = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map(match => ({ name: match[1], at: match.index }));
    const body = (name: string) => {
      const index = starts.findIndex(start => start.name === name);
      expect(index).toBeGreaterThanOrEqual(0);
      return source.slice(starts[index].at, starts[index + 1]?.at ?? source.length);
    };
    const reconcilers = starts.map(start => start.name).filter(name => /^reconcile\w+$/.test(name) && source.includes(`export async function ${name}(`));
    expect(reconcilers.length).toBeGreaterThanOrEqual(14);
    for (const name of [...reconcilers, "markModelDispatchIndeterminate"]) {
      const text = body(name);
      expect(text, name).toContain(`settlementTransaction("${name}", async tx`);
      expect(text.replaceAll("settlementTransaction(", ""), name).not.toMatch(/\btransaction\(/);
    }
  });
});
