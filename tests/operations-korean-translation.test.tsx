import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildActions, deriveStatus, splitActions, type ActionInputs } from "@/app/(operator)/admin/status/attention";
import { KoreanTranslationStatus, koreanTranslationRuntime } from "@/app/(operator)/admin/status/dashboard/KoreanTranslationStatus";
import { resolveWorkOwners, type OwnerContext } from "@/app/(operator)/admin/status/work-owners";
import { ACTION_NOW, brokenActionInputs } from "./fixtures/operations-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("server-only", () => ({}));

const now = ACTION_NOW.toISOString();
const queue = { eligible: 10, done: 4, ready: 3, recoveryReady: 0, retryScheduled: 2, blocked: 1, lastHour: 2, measuredAt: now };
const base = (over: Partial<OwnerContext> = {}): OwnerContext => ({ settings: {}, batch: null, agent: undefined, models: null,
  now, roles: [{ role: "text", ownerInstanceId: "m3-text", ownerKind: "primary", ownerRelease: "release-a", secondsUntilExpiry: 40 }],
  instances: [{ role: "text", instanceId: "m3-text", observedAt: now,
    value: { status: "running", release: "release-a", lanes: [] } }], jobs: new Map(), ...over });
const runtime = (job: string | null, options: { seconds?: number; release?: string; roleJob?: string } = {}) => {
  const ctx = base();
  ctx.instances[0] = { ...ctx.instances[0], observedAt: new Date(ACTION_NOW.getTime() - (options.seconds ?? 5) * 1_000).toISOString(), value: {
    status: "running", release: options.release ?? "release-a", currentJob: options.roleJob ?? job,
    lanes: [{ name: "reason-translate", jobs: ["reason-translate", "product-tagline-ko", "product-search-profile"],
      state: job ? "running" : "idle", currentJob: job, startedAt: job ? ACTION_NOW.getTime() - 1_000 : null,
      pollStartedAt: null, lastProgressAt: ACTION_NOW.getTime() - 1_000 }],
  } };
  return ctx;
};
const actions = (value: ActionInputs["koreanTranslation"]) => {
  const inputs = { ...brokenActionInputs(), koreanTranslation: value };
  return buildActions(inputs, { ...deriveStatus({ ...inputs, throughput: null }), workerProgress: null });
};

describe("한국어 번역 쌓인 일", () => {
  it("즉시 처리·예약·품질 중단을 분리하고, 옛 history에 키가 없어도 쌓인 일에 남긴다", () => {
    const item = actions({ ok: true, value: queue }).find((row) => row.key === "korean-translation")!;
    expect(item).toMatchObject({ count: 6, title: "제품 소개 한국어 번역", work: { jobs: ["product-tagline-ko"] } });
    const text = renderToStaticMarkup(createElement("div", null, item.detail));
    expect(text).toContain("즉시 처리 3");
    expect(text).toContain("재시도 예약 2");
    expect(text).toContain("품질 검사 중단 1");
    const split = splitActions([item], { now: ACTION_NOW, acks: new Map(), samples: [
      { at: new Date(ACTION_NOW.getTime() - 24 * 3_600_000).toISOString(), counts: { intro: 100 } },
    ] });
    expect(split.urgent).toEqual([]);
    expect(split.backlog[0]).toMatchObject({ key: "korean-translation", fresh: false });
  });
  it("0건·집계 실패는 적체가 있다는 행을 만들지 않는다", () => {
    for (const read of [undefined, null, { ok: false as const, reason: "down" as const },
      { ok: true as const, value: { ...queue, ready: 0, retryScheduled: 0, blocked: 0 } }]) {
      expect(actions(read).some((row) => row.key === "korean-translation")).toBe(false);
    }
  });
});

describe("한국어 번역의 실제 프로세스", () => {
  it("같은 기본 줄의 다른 작업과 별도 lane의 역할 currentJob을 한국어 실행으로 오인하지 않는다", () => {
    expect(koreanTranslationRuntime(runtime("product-tagline-ko"))).toBe("한국어 번역 실행 중");
    expect(koreanTranslationRuntime(runtime("product-search-profile"))).toContain("검색 키워드");
    expect(koreanTranslationRuntime(runtime("product-search-profile"))).not.toContain("한국어 번역 실행 중");
    expect(koreanTranslationRuntime(runtime(null, { roleJob: "product-translate" }))).toBe("공유 번역 줄 대기");
  });
  it("담당 만료·관측 지연·릴리스 불일치·관측 누락은 실행으로 표시하지 않는다", () => {
    expect(koreanTranslationRuntime(runtime("product-tagline-ko", { seconds: 46 }))).toBe("담당 워커 관측 지연");
    expect(koreanTranslationRuntime(runtime("product-tagline-ko", { release: "old" }))).toBe("담당·워커 릴리스 미확인");
    const unknown = runtime("product-tagline-ko", { release: "unknown" });
    unknown.roles![0].ownerRelease = "unknown";
    expect(koreanTranslationRuntime(unknown)).toBe("담당·워커 릴리스 미확인");
    const expired = runtime("product-tagline-ko");
    expired.roles![0].secondsUntilExpiry = 0;
    expect(koreanTranslationRuntime(expired)).toBe("담당 기한 지남");
    expect(koreanTranslationRuntime(base({ roles: null }))).toBe("담당 관측 미확인");
    const stopping = runtime(null);
    (stopping.instances[0].value.lanes as { state: string }[])[0].state = "stopping";
    expect(koreanTranslationRuntime(stopping)).toBe("공유 번역 줄 정지 중");
  });
  it("분리 배치에서는 text 대신 실제 translation 담당을 관측한다", () => {
    const ctx = runtime("product-tagline-ko");
    ctx.batch = { mode: "versioned", writerContractVersion: 1 };
    expect(koreanTranslationRuntime(ctx)).toBe("담당 관측 미확인");
    ctx.roles![0] = { ...ctx.roles![0], role: "translation", ownerInstanceId: "m3-translation" };
    ctx.instances[0] = { ...ctx.instances[0], role: "translation", instanceId: "m3-translation", value: {
      ...ctx.instances[0].value, lanes: [{ name: "reason-translate", jobs: ["reason-translate", "product-tagline-ko"],
        state: "running", currentJob: "product-tagline-ko", startedAt: ACTION_NOW.getTime() - 1_000,
        pollStartedAt: null, lastProgressAt: ACTION_NOW.getTime() - 1_000 }],
    } };
    expect(koreanTranslationRuntime(ctx)).toBe("한국어 번역 실행 중");
    ctx.batch = { mode: "draining", writerContractVersion: 1 };
    expect(koreanTranslationRuntime(ctx)).toBe("작업 배치 전환 중");
  });
  it("0건에도 카드·작업 일정·담당 버튼이 남고, 잡 실패/재시도와 실행 중을 구분한다", () => {
    const ctx = runtime(null);
    ctx.jobs = new Map([["product-tagline-ko", { notBefore: new Date(ACTION_NOW.getTime() + 60_000), lastError: "http_502",
      lastRunAt: ACTION_NOW, lastSuccessAt: ACTION_NOW, nextScheduledAt: new Date(ACTION_NOW.getTime() + 60_000) }]]);
    const owners = resolveWorkOwners({ jobs: ["product-tagline-ko"] }, ctx);
    const html = renderToStaticMarkup(createElement(KoreanTranslationStatus, {
      queue: { ok: true, value: { ...queue, ready: 0, retryScheduled: 0, blocked: 0 } },
      owners, runtime: koreanTranslationRuntime(ctx), hasLastError: true, now,
    }));
    expect(html).toContain('aria-label="제품 소개 한국어 번역"');
    expect(html).toContain("재시도 대기");
    expect(html).toContain("최근 실패 기록 있음");
    expect(html).toContain("공유 번역 줄 대기");
    expect(html).toContain("M3");
    expect(html).toContain("1분마다");
    expect(html).toContain("0건");
    expect(html).toContain("product-tagline-ko");
  });
  it("복제본 읽기 실패는 미확인으로 표시하며 대기0을 만들지 않는다", () => {
    const html = renderToStaticMarkup(createElement(KoreanTranslationStatus, {
      queue: { ok: false, reason: "down" }, owners: null, runtime: "담당 관측 미확인", hasLastError: false, now,
    }));
    expect(html).toContain("대기 수 미확인");
    expect(html).toContain("복제본에 연결되지 않습니다");
    expect(html).not.toContain("0건</dd>");
  });
});


it("shows both configured Korean translation backends and the expanded request budgets", () => {
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "true");
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "true");
  try {
    const ctx = runtime(null);
    const owners = resolveWorkOwners({ jobs: ["product-tagline-ko"] }, ctx);
    expect(owners?.models.some((row) => row.full === "qwen3.8-flash-next"
      && row.rows.some((entry) => entry.runsOn === "gpu3090 Qwen 직접 연결"))).toBe(true);
    const html = renderToStaticMarkup(createElement(KoreanTranslationStatus, {
      queue: { ok: true, value: { ...queue, ready: 5, recoveryReady: 2 } }, owners,
      runtime: koreanTranslationRuntime(ctx), hasLastError: false, now,
    }));
    expect(html).toContain("3,600");
    expect(html).toContain("2,250~5,400");
    expect(html).toContain("gpu3090 Qwen 직접 연결");
    expect(html).toContain("Qwen 제한 재검토 2건");
  } finally { vi.unstubAllEnvs(); }
});
