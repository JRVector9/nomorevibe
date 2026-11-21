import { describe, expect, it, vi } from "vitest";
import { CONTRACT_READER_FIELD, CONTRACT_READER_GENERATION, CONTRACT_READER_REQUIRED } from "@/lib/operations/contract-reader-mark";
import { contractReaderGateText, evaluateContractReaderGate, type ContractReaderInput } from "@/lib/operations/contract-reader-gate";

/**
 * 2026-11-21 abcllm 이름표 정리 2단계 — 새 모양 계약 저장·전환의 계약 읽기 관문(순수 판정). 관측·lease·후보 행은 이미 최근 창 안의 것이다.
 */
const NEW = "a".repeat(40), OLD = "b".repeat(40);
const mark = { [CONTRACT_READER_FIELD]: CONTRACT_READER_GENERATION };
const base: ContractReaderInput = {
  observations: [
    { key: "service:app:web-m3", value: { release: NEW, ...mark } },
    { key: "service:text:text-m3", value: { release: NEW, ...mark } },
    { key: "service:reviewer:ai2-consumer-m3", value: { release: NEW, ...mark } },
    // 서비스 관측이 아닌 키는 보지 않는다
    { key: "agent-scan:scan-1", value: { release: OLD } },
  ],
  leases: [{ role: "text", ownerInstanceId: "text-m3", ownerRelease: NEW }],
  candidates: [{ role: "translation", instanceId: "oracle-1", host: "oracle-osaka-smoke", release: NEW }],
};

describe("계약 읽기 관문", () => {
  it("모든 서비스 관측이 표지를 싣고 lease·후보의 release 가 그 관측에 있으면 열린다", () => {
    expect(CONTRACT_READER_REQUIRED).toBeLessThanOrEqual(CONTRACT_READER_GENERATION);
    const gate = evaluateContractReaderGate(base);
    expect(gate).toMatchObject({ ok: true, reason: null, checked: { observations: 3, leases: 1, candidates: 1 }, releases: [NEW.slice(0, 12)], stale: [] });
    expect(contractReaderGateText(gate)).toContain("모든 프로세스가 새 판입니다");
  });

  it("표지 없는 관측(옛 판), 낮은 세대, release 모름은 닫는다 — 옛 역할 키도 센다", () => {
    const gate = evaluateContractReaderGate({ ...base, observations: [...base.observations,
      { key: "service:reviewer:ai1-consumer-mini", value: { release: OLD } },
      { key: "service:crawler:crawler-m3", value: { release: NEW, [CONTRACT_READER_FIELD]: 0 } },
      { key: "service:connect-agent:connect", value: { release: "unknown", ...mark } },
      { key: "scheduler", value: { release: OLD } }] });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("stale_processes");
    expect(gate.stale).toEqual([
      { source: "observation", name: "reviewer:ai1-consumer-mini", release: OLD.slice(0, 12), reason: "no_marker" },
      { source: "observation", name: "crawler:crawler-m3", release: NEW.slice(0, 12), reason: "old_marker" },
      { source: "observation", name: "connect-agent:connect", release: null, reason: "release_missing" },
      { source: "observation", name: "scheduler", release: OLD.slice(0, 12), reason: "no_marker" }]);
    expect(contractReaderGateText(gate)).toContain("옛 판 프로세스 4개: reviewer:ai1-consumer-mini(옛 판(계약 읽기 표지 없음)");
  });

  it("관측을 남기지 않은 프로세스도 lease·후보의 release 로 잡는다(같은 release 의 표지 관측이 있어야 연다)", () => {
    const gate = evaluateContractReaderGate({ ...base, leases: [...base.leases, { role: "maintenance", ownerInstanceId: "maint-oracle", ownerRelease: OLD }],
      candidates: [...base.candidates, { role: "official-news", instanceId: "oracle-2", host: "oracle-osaka-smoke", release: "" }] });
    expect(gate.ok).toBe(false);
    expect(gate.stale).toEqual([
      { source: "lease", name: "maintenance:maint-oracle", release: OLD.slice(0, 12), reason: "release_unproven" },
      { source: "candidate", name: "official-news:oracle-osaka-smoke:oracle-2", release: null, reason: "release_missing" }]);
  });

  it("최근 서비스 관측이 하나도 없으면 아무것도 증명하지 못해 닫는다", () => {
    const gate = evaluateContractReaderGate({ observations: [], leases: [], candidates: [] });
    expect(gate).toMatchObject({ ok: false, reason: "no_observations" });
    expect(contractReaderGateText(gate)).toContain("서비스 관측이 없어");
    // 요구 세대를 올리면 지금 표지는 낮은 세대다
    expect(evaluateContractReaderGate(base, CONTRACT_READER_GENERATION + 1)).toMatchObject({ ok: false, reason: "stale_processes" });
  });

  it("서비스 관측은 언제나 이 판의 표지를 싣는다(observeService)", async () => {
    const writes: Record<string, unknown>[] = [];
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ db: { insert: () => ({ values: (row: { value: Record<string, unknown> }) => { writes.push(row.value);
      return { onConflictDoUpdate: async () => undefined }; } }) } }));
    const { observeService } = await import("@/lib/operations/observations");
    await observeService("text", { release: NEW, status: "running" });
    expect(writes).toEqual([{ release: NEW, status: "running", [CONTRACT_READER_FIELD]: CONTRACT_READER_GENERATION }]);
    vi.doUnmock("@/lib/db");
  });
});
