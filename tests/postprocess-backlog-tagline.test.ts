import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";

// 잡 시험만 대기열·호출을 바꾼다. 검사·정리(korean-tagline.ts)는 실제 함수다.
const m = vi.hoisted(() => ({ control: vi.fn(), pending: vi.fn(), write: vi.fn(), gpt: vi.fn() }));
vi.mock("@/lib/domain/products/korean-taglines", () => ({ homeListSlugs: async () => [], pendingKoreanTaglines: m.pending,
  pendingKoreanTaglineRecovery: async () => [], recordKoreanTaglines: m.write, koreanTaglineSource: (task: { tagline: string }) => task.tagline }));
vi.mock("@/lib/domain/products/korean-tagline-model-capacity", () => ({ translateKoreanTaglinesWithModelCapacity: m.gpt }));
vi.mock("@/lib/crawl/korean-translation-qwen", () => ({ translateKoreanTaglinesWithQwen: vi.fn() }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: m.control }));
const { checkKoreanTagline, checkKoreanTaglineOutput, leadClause, KOREAN_TAGLINE_MAX } = await import("@/lib/domain/products/korean-tagline");
const { writeKoreanTaglines } = await import("@/lib/jobs/products/korean-tagline");
const { capacityOwnerFromEnv } = await import("@/lib/llm/capacity-busy-targets");
const { setServingContractSnapshotForTest } = await import("@/lib/llm/serving-contract-store");
const { pinTextRanks, textContract } = await import("./text-task-ranks-fixture");

const source = { name: "Toolkit", tagline: "Toolkit helps teams organize documents and share notes across projects" };
const core = "Toolkit으로 팀 문서를 정리하고 프로젝트 사이에 메모를 공유하는 도구";
const long = (text: string) => { expect([...text].length).toBeGreaterThan(KOREAN_TAGLINE_MAX); return text; };

describe("checkKoreanTaglineOutput — 통과할 수 있는 출력은 정리해서 남긴다", () => {
  it("leaves a passing line untouched and marks no cleanup", () => {
    expect(checkKoreanTaglineOutput(core, source)).toEqual({ ok: true, line: core, cleaned: null });
  });

  it("drops a trailing parenthetical aside that made the line too long, then re-runs every check", () => {
    const output = long(`${core} (팀원 누구나 문서를 바로 찾고 프로젝트마다 묶어 보관할 수 있게 돕는 정리 기능)`);
    expect(checkKoreanTagline(output, source)).toEqual({ ok: false, reason: "too_long" });
    expect(checkKoreanTaglineOutput(output, source)).toEqual({ ok: true, line: core, cleaned: "parenthetical" });
  });

  it("keeps a mid-line parenthetical qualifier — only a trailing aside is dropped", () => {
    const beta = { name: "Toolkit", tagline: "Toolkit (beta) helps teams organize documents and share notes across projects" };
    const output = long(`Toolkit(베타)으로 팀 문서를 정리하고 프로젝트 사이에 메모를 공유하며 팀원 누구나 문서를 바로 찾고 함께 고치며 나누도록 돕는 문서 정리 도구`);
    expect(checkKoreanTaglineOutput(output, beta)).toEqual({ ok: false, reason: "too_long" });
  });

  it("keeps only the leading complete sentences when a second sentence overflows", () => {
    const output = long(`${core}입니다. 팀원 누구나 프로젝트 사이의 메모와 문서를 한곳에서 빠르게 찾고 함께 고치며 정리하도록 돕습니다.`);
    expect(checkKoreanTaglineOutput(output, source)).toEqual({ ok: true, line: `${core}입니다`, cleaned: "first_sentences" });
  });

  it("keeps the head before a spaced dash when the appositive overflows", () => {
    const output = long(`${core} — 팀원 누구나 프로젝트 사이의 메모와 문서를 한곳에서 빠르게 찾고 함께 고치도록 돕는 공간`);
    expect(checkKoreanTaglineOutput(output, source)).toEqual({ ok: true, line: core, cleaned: "dash_head" });
  });

  it("restores a spaced or re-cased product name to its original spelling", () => {
    const named = { name: "lemo-opuscar", tagline: "lemo-opuscar turns photos into short videos" };
    expect(checkKoreanTagline("Lemo Opuscar로 사진을 짧은 영상으로 바꾸는 도구", named)).toEqual({ ok: false, reason: "name_lost" });
    expect(checkKoreanTaglineOutput("Lemo Opuscar로 사진을 짧은 영상으로 바꾸는 도구", named))
      .toEqual({ ok: true, line: "lemo-opuscar로 사진을 짧은 영상으로 바꾸는 도구", cleaned: "name_spelling" });
  });

  it("does not repair a transliterated name — it is still rejected as name_lost", () => {
    const named = { name: "Wireshark", tagline: "Wireshark captures network packets" };
    expect(checkKoreanTaglineOutput("와이어샤크로 네트워크 패킷을 잡는 도구", named)).toEqual({ ok: false, reason: "name_lost" });
  });

  it("uses the first line of a multi-line answer only when that line passes on its own", () => {
    expect(checkKoreanTaglineOutput(`${core}\n번역: 설명을 덧붙임`, source)).toEqual({ ok: true, line: core, cleaned: "first_line" });
    expect(checkKoreanTaglineOutput("Toolkit\n문서를 정리하는 도구", source)).toEqual({ ok: false, reason: "multiline" });
  });

  it("never lets cleanup hide an invented claim — the kept part is checked again and the original reason stays", () => {
    const output = long(`Toolkit으로 3개 팀의 문서를 정리하는 도구입니다. 팀원 누구나 프로젝트 사이의 메모와 문서를 한곳에서 빠르게 찾고 함께 고치며 나누도록 돕습니다.`);
    expect(checkKoreanTagline(output, source)).toEqual({ ok: false, reason: "too_long" });
    expect(checkKoreanTaglineOutput(output, source)).toEqual({ ok: false, reason: "too_long" });
  });

  it("leaves an unbreakable over-long line rejected with its reason", () => {
    const output = long(`Toolkit으로 ${"팀 문서를 정리하고 ".repeat(8)}공유하는 도구`);
    expect(checkKoreanTaglineOutput(output, source)).toEqual({ ok: false, reason: "too_long" });
  });

  it("does not try cleanups for reasons cleanup cannot fix", () => {
    expect(checkKoreanTaglineOutput("", source)).toEqual({ ok: false, reason: "empty" });
    expect(checkKoreanTaglineOutput("Toolkit으로 Slack 문서를 정리하는 도구", source)).toEqual({ ok: false, reason: "invented_term" });
  });
});

describe("leadClause — 끊을 문장 끝이 없으면 한도 안의 마지막 쉼표까지", () => {
  it("shortens a long comma-only tagline instead of resending the same input", () => {
    const tagline = "Toolkit helps teams organize documents, share notes across many projects, review changes together, "
      + "and publish polished handbooks for every new teammate joining";
    expect(tagline.length).toBeGreaterThan(120);
    expect(leadClause(tagline)).toBe("Toolkit helps teams organize documents, share notes across many projects, review changes together");
  });

  it("keeps sentence boundaries first and leaves short taglines unchanged", () => {
    expect(leadClause("Toolkit organizes team documents. It also shares notes, comments and more")).toBe("Toolkit organizes team documents");
    expect(leadClause("Toolkit organizes documents, notes and comments")).toBe("Toolkit organizes documents, notes and comments");
  });
});

describe("koreanTaglineFailureRetryAllowed — 품질 외 실패는 정해진 횟수 뒤 손을 뗀다", () => {
  it("stops item failures at MAX_GATEWAY_FAILURES but keeps retrying clear provider outages", async () => {
    const { koreanTaglineFailureRetryAllowed, MAX_GATEWAY_FAILURES } = await vi.importActual<typeof import("@/lib/domain/products/korean-taglines")>(
      "@/lib/domain/products/korean-taglines");
    expect(koreanTaglineFailureRetryAllowed("invalid_output", MAX_GATEWAY_FAILURES - 1, 0)).toBe(true);
    expect(koreanTaglineFailureRetryAllowed("invalid_output", MAX_GATEWAY_FAILURES, 0)).toBe(false);
    expect(koreanTaglineFailureRetryAllowed("timeout", MAX_GATEWAY_FAILURES + 3, 3)).toBe(false);
    // 품질 거절은 따로 센다(MAX_REJECTIONS) — 품질 거절이 섞여도 품질 외 실패만 센다
    expect(koreanTaglineFailureRetryAllowed("rejected:too_long", MAX_GATEWAY_FAILURES + 3, 4)).toBe(true);
    for (const outage of ["network", "rate_limit", "no_key", "model_unavailable", "tokenizer_unavailable", "http_502", "http_503"])
      expect(koreanTaglineFailureRetryAllowed(outage, 40, 0)).toBe(true);
    expect(koreanTaglineFailureRetryAllowed("http_400", 40, 0)).toBe(false);
  });
});

describe("capacityOwnerFromEnv", () => {
  it("reads only a complete instance and UUID boot pair", () => {
    const bootId = "f7d9f24b-c29a-4ebd-b137-ac93196d270e";
    expect(capacityOwnerFromEnv({ ROLE_LEASE_INSTANCE_ID: "m3-text", ROLE_LEASE_BOOT_ID: bootId })).toEqual({ instanceId: "m3-text", bootId });
    expect(capacityOwnerFromEnv({ ROLE_LEASE_INSTANCE_ID: "m3-text", ROLE_LEASE_BOOT_ID: "not-a-uuid" })).toBeUndefined();
    expect(capacityOwnerFromEnv({ ROLE_LEASE_BOOT_ID: bootId })).toBeUndefined();
  });
});

describe("writeKoreanTaglines — 정리된 줄을 저장하고 미룸 사유를 남긴다", () => {
  const task = (id: number) => ({ productId: id, name: "Toolkit", tagline: source.tagline, repoUrl: null, attempts: 0 });
  const ctx = () => ({ lease: { name: "product-tagline-ko", token: "lease", requestedVersion: 1 },
    hasBudget: () => true, log: vi.fn(), signal: undefined }) as unknown as JobContext<null> & { log: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "false");
    // GPT opens only on an admin engine row connected directly (transport direct); the abcLLM gateway key was removed (2026-10-30).
    // PR B: 모델은 「작업 ↔ 모델」 순위가 고른다 — 그 순위의 연결을 가리키는 계약이 있어야 연다
    pinTextRanks({ "product-tagline-ko": "[MLX] gpt-oss-120b" });
    setServingContractSnapshotForTest([textContract("product-tagline-ko", "[MLX] gpt-oss-120b")]);
    m.control.mockResolvedValue({ mode: "disabled" });
    m.write.mockImplementation(async entries => entries.length);
  });
  afterEach(() => { vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); pinTextRanks(null); });

  it("stores the cleaned line as a success instead of another too_long rejection", async () => {
    m.pending.mockResolvedValueOnce([task(1), task(2)]).mockResolvedValue([]);
    m.gpt.mockResolvedValueOnce({ kind: "result", result: { ok: true, outputs: [
      `${core} (팀원 누구나 문서를 바로 찾고 프로젝트마다 묶어 보관할 수 있게 돕는 정리 기능)`,
      `Toolkit으로 ${"팀 문서를 정리하고 ".repeat(8)}공유하는 도구`] } });
    const context = ctx();
    await writeKoreanTaglines(context);
    const entries = m.write.mock.calls.flatMap(([rows]) => rows);
    expect(entries.map(entry => entry.result)).toEqual([
      { kind: "success", line: core, model: "[MLX] gpt-oss-120b" },
      { kind: "failure", error: "rejected:too_long", model: "[MLX] gpt-oss-120b" }]);
    expect(context.log).toHaveBeenCalledWith("tagline_ko.done", expect.objectContaining({ written: 1,
      rejected: { too_long: 1 }, cleaned: { parenthetical: 1 } }));
  });

  it("logs the exact capacity deferral reason before deferring the tick", async () => {
    m.pending.mockResolvedValueOnce([task(1)]);
    const deferred = new ModelCapacityDeferredError("dispatched");
    m.gpt.mockRejectedValueOnce(deferred);
    const context = ctx();
    await expect(writeKoreanTaglines(context)).rejects.toBe(deferred);
    expect(context.log).toHaveBeenCalledWith("tagline_ko.capacity_deferred", expect.objectContaining({ reason: "dispatched" }));
    expect(m.write).not.toHaveBeenCalled();
  });
});
