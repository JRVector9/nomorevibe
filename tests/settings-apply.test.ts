import { describe, expect, it } from "vitest";
import { describeReset } from "@/app/(operator)/admin/settings/reset-diff";
import { resetChanges } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { shortSettingsVersion, storedSettingsVersion } from "@/lib/crawl/settings-version";
import { CRAWL_SETTINGS_APPLY, RUNTIME_SETTINGS_APPLY, RUNTIME_SETTINGS_ROLES, runtimeSettingsApplyStatus, settingsApplyStatus, SETTINGS_LAG_SECONDS,
  type ApplyObservation } from "@/lib/operations/settings-apply";

/** 설정 적용 확인(ADM-19) — 저장한 판을 워커 역할마다 읽었는지 */
describe("설정 판", () => {
  it("저장된 원본이 같으면 같은 판, 다르면 다른 판이다. 행이 없을 때도 판이 있다", () => {
    expect(storedSettingsVersion({ enabled: true })).toBe(storedSettingsVersion({ enabled: true }));
    expect(storedSettingsVersion({ enabled: true })).not.toBe(storedSettingsVersion({ enabled: false }));
    expect(storedSettingsVersion(undefined)).toBe(storedSettingsVersion(null));
    expect(shortSettingsVersion("3f9a2c1b00ff")).toBe("v3f9a2c");
  });
});

describe("역할별 적용 상태", () => {
  const SAVED = "a".repeat(16), OLD = "b".repeat(16);
  const service = (role: string, value: Record<string, unknown>, ageSeconds = 5, instance = "m3"): ApplyObservation =>
    ({ key: `service:${role}:${instance}`, value: { status: "running", ...value }, ageSeconds });
  const status = (observations: ApplyObservation[], savedAgeSeconds: number | null = 30) =>
    settingsApplyStatus({ savedVersion: SAVED, savedAgeSeconds, observations });
  const role = (result: ReturnType<typeof status>, name: string) => result.roles.find((item) => item.role === name)!;

  it("모든 역할이 저장된 판을 읽었으면 초록 체크, 조치할 일 없음", () => {
    const result = status(["crawler", "reviewer", "publisher", "text"].map((name) =>
      service(name, { settingsVersion: SAVED, settingsReadAt: 1_700_000_000_000 })));
    expect(result.allApplied).toBe(true);
    expect(result.attention).toBeNull();
    expect(role(result, "crawler")).toMatchObject({ state: "applied", reportedVersion: SAVED, observedAt: 1_700_000_000_000 });
  });

  it("옛 판은 대기 — 저장한 지 10분 안이면 조치할 일로 올리지 않는다", () => {
    const result = status([service("crawler", { settingsVersion: SAVED }), service("reviewer", { settingsVersion: OLD })], SETTINGS_LAG_SECONDS - 1);
    expect(role(result, "reviewer")).toMatchObject({ state: "waiting", lagging: false });
    expect(result.allApplied).toBe(false);
    expect(result.attention).toBeNull();
  });

  it("10분이 지나도 옛 판이면 조치할 일 — 운영센터 한 칸 모양으로", () => {
    const result = status([service("reviewer", { settingsVersion: OLD }), service("text", { settingsVersion: OLD })], SETTINGS_LAG_SECONDS + 60);
    expect(result.attention).toMatchObject({ key: "settings-apply", tone: "hold", count: 2, href: "/admin#apply" });
    expect(result.attention?.detail).toContain("후보 심사·소개·사유 번역");
    expect(result.attention?.detail).toContain("11분");
  });

  it("같은 역할 밑 consumer 관측(판을 싣지 않음)이 더 최근이어도 역할 워커의 판으로 본다", () => {
    const result = status([service("crawler", { settingsVersion: SAVED }, 10), service("crawler", {}, 1, "agent-scan-consumer-m3")]);
    expect(role(result, "crawler")).toMatchObject({ state: "applied", reportedVersion: SAVED });
  });

  it("판을 싣지 않는 옛 워커는 '확인 안 됨'이고 조치할 일로 올리지 않는다", () => {
    const result = status([service("crawler", {})], SETTINGS_LAG_SECONDS * 10);
    expect(role(result, "crawler")).toMatchObject({ state: "unknown", reportedVersion: null, lagging: false });
    expect(result.attention).toBeNull();
  });

  it("관측이 1분 넘게 없거나 멈춘 역할은 '관측 없음' — 주·예비가 바뀌면 최근 인스턴스를 본다", () => {
    const result = status([
      service("crawler", { settingsVersion: OLD }, 200, "old-primary"),
      service("crawler", { settingsVersion: SAVED }, 3, "mini"),
      service("reviewer", { settingsVersion: OLD }, 120),
      service("publisher", { settingsVersion: OLD, status: "failed" }),
    ], SETTINGS_LAG_SECONDS * 10);
    expect(role(result, "crawler").state).toBe("applied");
    expect(role(result, "reviewer").state).toBe("inactive");
    expect(role(result, "publisher").state).toBe("inactive");
    expect(role(result, "text").state).toBe("inactive");
    expect(result.attention).toBeNull();
  });

  it("예전 키(역할 이름만)의 관측도 읽고, 설정을 드물게 읽는 역할(maintenance·scheduler)은 보지 않는다", () => {
    const result = status([{ key: "crawler", value: { status: "running", settingsVersion: SAVED }, ageSeconds: 4 },
      service("maintenance", { settingsVersion: OLD })], SETTINGS_LAG_SECONDS * 10);
    expect(role(result, "crawler").state).toBe("applied");
    expect(result.roles.map((item) => item.role)).toEqual(["crawler", "reviewer", "publisher", "text"]);
  });

  it("kind 를 생략하면 크롤 설정이다 — 같은 입력에 같은 결과", () => {
    const observations = [service("crawler", { settingsVersion: SAVED }), service("reviewer", { settingsVersion: OLD })];
    expect(settingsApplyStatus({ savedVersion: SAVED, savedAgeSeconds: SETTINGS_LAG_SECONDS + 60, observations, kind: CRAWL_SETTINGS_APPLY }))
      .toEqual(settingsApplyStatus({ savedVersion: SAVED, savedAgeSeconds: SETTINGS_LAG_SECONDS + 60, observations }));
  });
});

/** 실시간 한도(runtime_settings, PR 1a) 의 '읽은 판' — 같은 길, 다른 관측 필드·다섯 역할·env 등록부 배지 */
describe("실시간 한도의 역할별 적용 상태", () => {
  const SAVED = "c".repeat(16), OLD = "default", READ_AT = 1_700_000_000_000;
  const service = (role: string, value: Record<string, unknown>, ageSeconds = 5, instance = "m3"): ApplyObservation =>
    ({ key: `service:${role}:${instance}`, value: { status: "running", ...value }, ageSeconds });
  const read = (version: string, registryEnv = false) => ({ runtimeSettingsVersion: version, runtimeSettingsReadAt: READ_AT, runtimeSettingsRegistryEnv: registryEnv });
  const status = (observations: ApplyObservation[], savedAgeSeconds: number | null = 30) =>
    runtimeSettingsApplyStatus({ savedVersion: SAVED, savedAgeSeconds, observations });
  const role = (result: ReturnType<typeof status>, name: string) => result.roles.find((item) => item.role === name)!;

  it("runtimeSettings* 필드를 읽고 maintenance 까지 다섯 역할을 본다 — 크롤 설정 판은 섞이지 않는다", () => {
    const result = status([...RUNTIME_SETTINGS_ROLES].map((name) => service(name, { settingsVersion: "zzzz", ...read(SAVED) })));
    expect(result.roles.map((item) => item.role)).toEqual(["crawler", "reviewer", "publisher", "text", "maintenance"]);
    expect(result.allApplied).toBe(true);
    expect(result.attention).toBeNull();
    expect(role(result, "maintenance")).toEqual({ role: "maintenance", label: "생존 확인·지표 집계", reportedVersion: SAVED, observedAt: READ_AT,
      state: "applied", lagging: false, registryEnv: false });
    expect(RUNTIME_SETTINGS_APPLY.fields).toEqual({ version: "runtimeSettingsVersion", readAt: "runtimeSettingsReadAt", registryEnv: "runtimeSettingsRegistryEnv" });
  });

  it("MODEL_REGISTRY_CONFIG env 로 도는 역할은 판을 읽었어도 registryEnv 로 표시한다(경로 한도 저장이 닿지 않는다)", () => {
    const result = status([service("text", read(SAVED, true)), service("crawler", read(OLD, true))]);
    expect(role(result, "text")).toMatchObject({ state: "applied", registryEnv: true });
    expect(role(result, "crawler")).toMatchObject({ state: "waiting", registryEnv: true });
  });

  it("실시간 한도 판을 싣지 않는 옛 워커는 '확인 안 됨'이고 배지도 없다; 크롤 설정 판만 있어도 같다", () => {
    const result = status([service("crawler", {}), service("reviewer", { settingsVersion: SAVED, settingsReadAt: READ_AT })], SETTINGS_LAG_SECONDS * 10);
    expect(role(result, "crawler")).toEqual({ role: "crawler", label: "프로젝트 수집", reportedVersion: null, observedAt: null, state: "unknown", lagging: false });
    expect(role(result, "reviewer").state).toBe("unknown");
    expect(result.attention).toBeNull();
  });

  it("10분이 지나도 옛 판이면 조치할 일 — 실시간 한도 화면의 적용 확인으로 보낸다", () => {
    const result = status([service("text", read(OLD)), service("maintenance", read(OLD)), service("crawler", read(SAVED))], SETTINGS_LAG_SECONDS + 60);
    expect(result.attention).toMatchObject({ key: "runtime-settings-apply", tone: "hold", count: 2, href: "/admin/models/limits#apply",
      title: "저장한 실시간 한도가 워커에 닿지 않음" });
    expect(result.attention?.detail).toContain("소개·사유 번역·생존 확인·지표 집계 이(가) 실시간 한도를 저장하고 11분");
    expect(result.attention?.detail).toContain("poll");
    // 크롤 설정 쪽 글귀는 그대로다
    const crawl = settingsApplyStatus({ savedVersion: SAVED, savedAgeSeconds: SETTINGS_LAG_SECONDS + 60, observations: [service("text", { settingsVersion: OLD })] });
    expect(crawl.attention).toMatchObject({ key: "settings-apply", href: "/admin#apply", title: "저장한 설정이 워커에 닿지 않음" });
    expect(crawl.attention?.detail).toBe("소개·사유 번역 이(가) 설정을 저장하고 11분이 지나도 옛 판으로 돕니다. 설정을 읽는 잡이 돌지 못하고 있는지 운영센터의 역할·작업 표에서 확인하세요.");
  });

  it("빈 문서(default 판)로 도는 워커와 빈 행은 같은 판 — 저장한 적이 없으면 늦을 것이 없다", () => {
    const result = runtimeSettingsApplyStatus({ savedVersion: "default", savedAgeSeconds: null, observations: [service("crawler", read("default"))] });
    expect(role(result, "crawler").state).toBe("applied");
    expect(role(result, "text").state).toBe("inactive");
  });
});

/** 기본값 되돌리기 확인 창(ADM-06) — 비교표에 없는 값까지 실제로 바뀔 값을 모두 보인다 */
describe("기본값 되돌리기의 바뀔 값", () => {
  it("바꾼 값만 지금 → 기본값으로 적고, 수집 스위치와 리뷰 모드는 그대로 둔다", () => {
    const current = {
      ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce" as const, reviewConcurrency: 4,
      judge: { ...DEFAULT_CRAWL_SETTINGS.judge, excludeForks: !DEFAULT_CRAWL_SETTINGS.judge.excludeForks,
        blockedHomepageDomains: [...DEFAULT_CRAWL_SETTINGS.judge.blockedHomepageDomains.slice(1), "evil.example"] },
    };
    const changes = resetChanges(current);
    expect(changes.map((change) => change.path).sort()).toEqual(["judge.blockedHomepageDomains", "judge.excludeForks", "reviewConcurrency"]);

    const lines = describeReset(changes);
    expect(lines).toContainEqual({ label: "1차 심사 동시 실행 수", before: "4", after: "2" });
    expect(lines).toContainEqual({ label: "포크 제외", before: current.judge.excludeForks ? "켬" : "끔", after: current.judge.excludeForks ? "끔" : "켬" });
    const domains = lines.find((line) => line.label === "차단 도메인")!;
    expect(domains.note).toContain(`더함 ${DEFAULT_CRAWL_SETTINGS.judge.blockedHomepageDomains[0]}`);
    expect(domains.note).toContain("빠짐 evil.example");
  });

  it("카테고리 기준처럼 갈래가 많은 묶음은 한 줄로 접고, 모르는 경로는 경로 그대로 보인다", () => {
    const lines = describeReset([
      { path: "classify.definitions.Dev.summary", before: "a", after: "b" },
      { path: "classify.definitions.Design.summary", before: "a", after: "b" },
      { path: "future.knob", before: 1, after: null },
      { path: "secondReview.voters", before: [{ provider: "abcllm", model: "qwen" }], after: [{ provider: "grok-cli", model: "grok-4.7" }] },
    ]);
    expect(lines).toContainEqual({ label: "카테고리 기준", before: "바꾼 값 2곳", after: "기본값" });
    expect(lines).toContainEqual({ label: "future.knob", before: "1", after: "없음" });
    expect(lines).toContainEqual({ label: "2차 심사 모델", before: "1개", after: "1개", note: "더함 grok-4.7 · 빠짐 qwen" });
  });
});
