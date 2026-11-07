import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FirstReviewStatusCard, type FirstReviewStatusProps } from "@/app/(operator)/admin/status/FirstReviewStatus";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { firstReviewStatusSql, FIRST_REVIEW_SAMPLE_LIMIT, type FirstReviewStatus } from "@/lib/operations/first-review-status";
import { buildPipelineCompletions } from "@/lib/operations/pipeline-completions";
import { buildPipelineControlStatus } from "@/lib/operations/pipeline-control-status";
import { pinReviewRanks, pinReviewRanksFromSettings } from "./review-task-ranks-fixture";

const NOW = "2026-10-27T07:30:00.000Z";
const settings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm" as const, model: "first-model" },
  secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "abcllm" as const, model: "second-model" }] } };
const props = (): FirstReviewStatusProps => ({ settings, throughput: null, progress: null, jobs: [], now: NOW,
  read: { ok: false, reason: "lagging" }, completions: buildPipelineCompletions(null), control: { stages: [] } });
const sample = (): FirstReviewStatus => ({ at: NOW, sampled: FIRST_REVIEW_SAMPLE_LIMIT, truncated: true,
  windows: ([5, 15, 60] as const).map(minutes => ({ minutes, succeeded: 3, failed: 1, unique: 2,
    approve: 1, reject: 1, handoff: 1, cancelled: 2, reuse: 4, rules: 5 })),
  recent: [{ id: 4, candidateId: 3, provider: "abcllm", model: "observed-model", state: "succeeded", decision: "reject", completedAt: NOW }],
});
const html = (over: Partial<FirstReviewStatusProps> = {}) => renderToStaticMarkup(createElement(FirstReviewStatusCard, { ...props(), ...over }));

describe("AI 1차 상세 상태", () => {
  // 화면의 1차·2차 모델 자리는 「작업 ↔ 모델」 순위를 읽는다(PR C1) — 시험 설정과 같은 모델을 1차 1순위·2차 칸 1 의 1순위로 고정한다
  beforeEach(() => pinReviewRanksFromSettings(settings));
  afterEach(() => pinReviewRanks(null));

  it("복제 지연과 집계 0건을 구분하고 설정·목적을 남긴다", () => {
    const out = html();
    expect(out).toContain("복제본이 10초 넘게 밀렸습니다");
    expect(out).toContain("0건을 뜻하지 않습니다");
    expect(out).toContain("실행 가능 대기</dt><dd class=\"font-mono text-lg\">미확인");
    expect(out).toContain("first-model");
    expect(out).toContain("second-model");
    expect(out).toContain("홈페이지 본문·README");
    expect(out).toContain("AI 사용 여부·제작 단계 판정은 개발 AI 근거 단계");
  });

  it("거절·사람 확인도 기술 성공에 넣고 상한 표본의 분모를 밝힌다", () => {
    const out = html({ read: { ok: true, value: sample() } });
    expect(out).toContain("75.0% (3/4)");
    expect(out).toContain("전체 수량·전체 성공률이 아닙니다");
    expect(out).toContain("승인·거절·사람 확인 모두 기술 성공");
    expect(out).toContain("observed-model");
    expect(out).toContain("후보 #3");
    expect(out).not.toContain("100.0%");
  });

  it("종료 시도가 없는 창은 100% 성공으로 만들지 않는다", () => {
    const value = sample();
    value.truncated = false;
    value.windows = value.windows.map(row => ({ ...row, succeeded: 0, failed: 0, unique: 0, approve: 0, reject: 0, handoff: 0 }));
    value.recent = [];
    const out = html({ read: { ok: true, value } });
    expect(out).toContain("해당 없음 · 종료 시도 0회");
    expect(out).not.toContain("100.0%");
  });

  it("캐시와 오래된 집계를 명시한다", () => {
    const out = html({ read: { ok: true, value: { ...sample(), at: "2026-10-27T07:20:00.000Z" } } });
    expect(out).toContain("최대 60초 캐시");
    expect(out).toContain("오래된 집계");
  });

  const groupControl = (state: "dispatched" | "indeterminate") => {
    const control = buildPipelineControlStatus(null, null);
    control.observedAt = NOW;
    Object.assign(control.controls.find(row => row.key === "model")!, { mode: "open", policy: "verified", metrics: [] });
    control.runtime.modelGroups = [{ group: "shared-first-group", limit: 1,
      firstModels: [{ provider: "abcllm", model: "first-model" }], waitingFirst: 4, reserved: 0,
      dispatched: state === "dispatched" ? 1 : 0, indeterminate: state === "indeterminate" ? 1 : 0,
      occupants: [{ route: "reason-translate", state, count: 1 }] }];
    return control;
  };

  it("자신의 실패가 없어도 번역의 보낸 호출 점유가 막는 공유 그룹을 표시한다", () => {
    const out = html({ control: groupControl("dispatched") });
    expect(out).toContain("공유 모델 슬롯 대기");
    expect(out).toContain("shared-first-group");
    expect(out).toContain("reason-translate");
    expect(out).toContain("호출 미정산 1건");
    expect(out).toContain("AI 1차 실행0·실패0만으로 용량이 비었다고 판단하지 않습니다");
  });

  it("확인 못함(미확인) 호출은 점유·막힘이 아니라 사람 검토 목록으로 보낸다 (2026-10-30)", () => {
    const out = html({ control: groupControl("indeterminate") });
    expect(out).not.toContain("공유 모델 슬롯 대기");
    expect(out).toContain("유효 예약·호출 0 / 상한 1");
    expect(out).toContain("확인 못함 1건 · 사람 검토");
    expect(out).toContain("확인 못함 · 사람 검토(점유 아님) 1건");
    expect(out).toContain('href="/admin/models/history#retry"');
    expect(out).not.toMatch(/종료 미확정|계속 점유/);
  });

  it("대기 나이를 모르면 수집 압력 미만이라고 단정하지 않는다", () => {
    const out = html({ throughput: { measuredAt: NOW, stages: [{ key: "first", label: "AI 1차", unit: "건", enabled: true,
      completed1m: 0, completed5m: 0, waiting: 700, oldestMinutes: null, errors5m: null,
      queueNote: "", detail: "", status: "idle" }] } });
    expect(out).toContain("수집 압력 여부는 미확인");
    expect(out).not.toContain("진입 기준 미만입니다");
  });
});

describe("AI 1차 상세 집계 SQL", () => {
  it("시간·자동시도 필터 전에 PK 역순 상한을 적용한다", () => {
    const query = new PgDialect().sqlToQuery(firstReviewStatusSql());
    const beforeFilter = query.sql.slice(0, query.sql.indexOf("ended AS MATERIALIZED"));
    expect(beforeFilter).toContain("ORDER BY id DESC LIMIT");
    expect(beforeFilter).not.toContain("WHERE");
    expect(query.params).toContain(FIRST_REVIEW_SAMPLE_LIMIT + 1);
    expect(query.params).toContain(FIRST_REVIEW_SAMPLE_LIMIT);
    expect(query.sql).toContain("(VALUES (5), (15), (60))");
    expect(query.sql).not.toContain("model_capacity_requests");
    expect(query.sql).not.toContain("FOR UPDATE");
  });
});
