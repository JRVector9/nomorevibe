import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { TextTaskRanksStatus } from "@/app/(operator)/admin/status/TextTaskRanksStatus";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { resolveTextTaskRanks } from "@/lib/llm/ai-task-resolver";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { pinTextRanks, textContract, textRankRow } from "./text-task-ranks-fixture";

/** 상태 화면의 「작업 ↔ 모델 · text 작업 순위」 칸(PR B) — 저장한 순위·쓸 수 없는 까닭·마지막 틱에서 일한 순위와 아래 순위를 쓴 까닭. */
afterEach(() => { setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null); });

it("일한 순위·아래 순위를 쓴 까닭·순위 없음을 보인다", () => {
  setServingContractSnapshotForTest([textContract("product-search-profile", "qwen3.6-35b", { baseUrl: "http://second.test:8000/v1" })]);
  pinTextRanks([textRankRow("product-search-profile", "gpt-oss-120b", { label: "gpu3090" }),
    textRankRow("product-search-profile", "qwen3.6-35b", { rank: 2, connectionId: "0b0c0d0e-0000-4000-8000-0000000000aa", baseUrl: "http://second.test:8000/v1", label: "supa" })]);
  const html = renderToStaticMarkup(createElement(TextTaskRanksStatus, { lines: [
    { task: "product-search-profile", resolution: resolveTextTaskRanks("product-search-profile"), runtime: { from: "job", at: "2026-11-02T03:00:00.000Z",
      served: [{ rank: 2, count: 4 }], unusable: [{ rank: 1, code: "no_direct_contract", text: "이 연결·모델의 엔진 직접 계약이 없음(그 줄을 다시 저장하면 만듦)", count: 1 }],
      degraded: null } },
    { task: "crawl-tagline", resolution: resolveTextTaskRanks("crawl-tagline"), runtime: { from: "job", at: "2026-11-02T03:00:00.000Z", served: [], unusable: [],
      degraded: { code: "no_task_models", detail: "d" } } },
  ] }));
  expect(html).toContain("검색 키워드 짓기");
  expect(html).toContain("gpu3090 · gpt-oss-120b");
  expect(html).toContain("쓸 수 없음: 이 연결·모델의 엔진 직접 계약이 없음");
  expect(html).toContain("2순위 4건");
  expect(html).toContain("아래 순위를 쓴 까닭 — 1순위: 이 연결·모델의 엔진 직접 계약이 없음");
  expect(html).toContain("순위 없음 — 이 작업은 돌지 않습니다(no_task_models)");
  expect(html).toContain("제 일 못 함 <code>no_task_models</code>");
  expect(html).toContain('href="/admin/models/tasks#tasks"');
});
