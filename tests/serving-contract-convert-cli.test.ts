import { beforeEach, describe, expect, it, vi } from "vitest";

/** 운영 스크립트 scripts/ops/serving-contract-convert.ts — 인자·종료 코드·출력(관리 화면과 같은 함수를 부른다, DB 없이). */
const lib = vi.hoisted(() => ({ plan: vi.fn(), apply: vi.fn(), gate: vi.fn() }));
vi.mock("@/lib/operations/contract-reader-gate", () => ({ readContractReaderGate: lib.gate,
  contractReaderGateText: (gate: { ok: boolean }) => gate.ok ? "모든 프로세스가 새 판입니다" : "옛 판 프로세스 1개" }));
vi.mock("@/lib/operations/serving-contract-convert", () => ({ planServingContractConversion: lib.plan, applyServingContractConversion: lib.apply,
  conversionPlanLines: (plan: { routeId: string }) => [`전환 계획 · ${plan.routeId}`] }));
const { parseServingContractConvertArgs, runServingContractConvert } = await import("@/scripts/ops/serving-contract-convert");
const HASH = "a".repeat(64);
const run = async (argv: string[]) => { const out: string[] = [], err: string[] = [];
  const code = await runServingContractConvert(argv, line => out.push(line), line => err.push(line)); return { code, out, err }; };

beforeEach(() => { lib.plan.mockReset(); lib.apply.mockReset(); lib.gate.mockReset(); });

describe("serving-contract-convert 운영 스크립트", () => {
  it("--key=value 와 --json 만 받는다 — 모르는·중복·빈 옵션은 사용법(2)", async () => {
    expect(parseServingContractConvertArgs(["plan", "--route=crawl-tagline", "--model=m@1a2b3c4d", "--action=revert", "--json"]))
      .toEqual({ command: "plan", route: "crawl-tagline", model: "m@1a2b3c4d", action: "revert", hash: null, operator: null, json: true });
    for (const argv of [["plan", "--route=a", "--route=b"], ["plan", "--route="], ["plan", "--other=x"], ["plan", "--action=delete"], ["plan", "route=a"]])
      expect(parseServingContractConvertArgs(argv)).toBeNull();
    expect((await run(["plan"])).code).toBe(2);
    expect((await run(["apply", "--route=crawl-tagline", "--operator=jr"])).code).toBe(2);
    expect((await run(["apply", "--route=crawl-tagline", "--hash=short", "--operator=jr"])).code).toBe(2);
    expect((await run(["delete", "--route=crawl-tagline"])).code).toBe(2);
    expect(lib.plan).not.toHaveBeenCalled(); expect(lib.apply).not.toHaveBeenCalled();
  });

  it("plan: 계획 줄과 hash 를 찍고, 실행할 수 없으면(관문 닫힘·할 것 없음) 3", async () => {
    lib.plan.mockResolvedValueOnce({ routeId: "crawl-tagline", planHash: HASH, blocked: null });
    expect(await run(["plan", "--route=crawl-tagline"])).toEqual({ code: 0, out: ["전환 계획 · crawl-tagline", `hash=${HASH}`], err: [] });
    expect(lib.plan).toHaveBeenCalledWith({ action: "convert", routeId: "crawl-tagline", model: null });
    lib.plan.mockResolvedValueOnce({ routeId: "crawl-tagline", planHash: HASH, blocked: "contract_reader_gate_closed" });
    expect((await run(["plan", "--route=crawl-tagline", "--action=revert", "--model=m"])).code).toBe(3);
    expect(lib.plan).toHaveBeenLastCalledWith({ action: "revert", routeId: "crawl-tagline", model: "m" });
  });

  it("apply: 계획 hash·운영자 이름으로 부르고, 거절은 고정 code 한 줄(1)", async () => {
    lib.apply.mockResolvedValueOnce({ action: "convert", saved: [{ model: "m", previousId: 3, id: 9, contractHash: "b".repeat(64) }],
      appended: [{ routeId: "crawl-tagline", provider: "local-direct", model: "m", providerBudgetId: "acct", groupId: "dev" }], policyRevision: 12, refusals: [] });
    const done = await run(["apply", "--route=crawl-tagline", `--hash=${HASH}`, "--operator=jr"]);
    expect(done).toEqual({ code: 0, err: [], out: ["전환 m #3 → #9 (bbbbbbbbbbbb)", "정책 덧붙임 crawl-tagline / local-direct / m → acct · dev", "정책 판 12"] });
    expect(lib.apply).toHaveBeenCalledWith({ action: "convert", routeId: "crawl-tagline", model: null, planHash: HASH }, "jr");
    lib.apply.mockRejectedValueOnce(new Error("serving_contract_convert_plan_changed"));
    expect(await run(["apply", "--route=crawl-tagline", `--hash=${HASH}`, "--operator=jr"]))
      .toEqual({ code: 1, out: [], err: ['{"code":"serving_contract_convert_plan_changed"}'] });
    lib.apply.mockRejectedValueOnce(new Error("connect ECONNREFUSED db.invalid:5432 with secret"));
    expect((await run(["apply", "--route=crawl-tagline", `--hash=${HASH}`, "--operator=jr"])).err).toEqual(['{"code":"serving_contract_convert_failed"}']);
  });

  it("gate: 관문만 읽는다 — 닫혀 있으면 3", async () => {
    lib.gate.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
    expect(await run(["gate"])).toEqual({ code: 0, out: ["모든 프로세스가 새 판입니다"], err: [] });
    expect(await run(["gate", "--json"])).toEqual({ code: 3, out: ['{"ok":false}'], err: [] });
  });
});
