import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(async () => null as { login: string } | null) }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { ConnectionForm } from "@/app/(operator)/admin/models/tasks/ConnectionForm";
import { TaskImportCard } from "@/app/(operator)/admin/models/tasks/TaskImportCard";
import { TaskRanksBoard, type TaskRankLine } from "@/app/(operator)/admin/models/tasks/TaskRanksBoard";
import * as actions from "@/app/(operator)/admin/models/tasks/actions";
import type { AiConnectionView } from "@/lib/operations/admin-ai-tasks";

const GPU = "11111111-1111-4111-8111-111111111111";
const gpu: AiConnectionView = { id: GPU, label: "gpu3090", kind: "api", baseUrl: "http://100.77.43.63:8090/v1", host: "100.77.43.63:8090", hasKey: true, cliTool: null,
  cliModels: [], models: [{ id: "qwen3.8-flash-next", maxModelLen: 131072 }], modelsReadAt: null, modelsError: null, deviceId: "gpu3090-qwen", capacitySlots: 4,
  contextTokens: null, enabled: true, version: 3, note: null, updatedBy: "t", updatedAt: "2026-11-02T00:00:00.000Z" };
const line = (patch: Partial<TaskRankLine> = {}): TaskRankLine => ({ task: "crawl-tagline", slot: 1, label: "수집 소개 짓기", group: "text", kind: "chat",
  description: "소개를 짓습니다.", accepts: "API 주소", revision: "a".repeat(64), rows: [{ task: "crawl-tagline", slot: 1, rank: 1, connectionId: GPU, model: "qwen3.8-flash-next",
    options: {}, enabled: true }], options: [{ provider: GPU, model: "qwen3.8-flash-next", label: "gpu3090 · qwen3.8-flash-next" }],
  current: { labels: ["gpu3090 · qwen3.8-flash-next"], source: "단계 풀", notes: [], error: null, skip: null }, sameAsCurrent: true,
  readiness: [{ rank: 1, blocking: [], warnings: [], pending: [] }], ...patch });

describe("작업 ↔ AI 모델 화면", () => {
  it("연결 폼: 고치기에서는 종류를 못 바꾸고, 저장된 키는 다시 보이지 않는다(「키 지우기」만)", () => {
    const html = renderToStaticMarkup(createElement(ConnectionForm, { initial: gpu, secretBox: true }));
    expect(html).toContain('name="id" value="11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('name="expectedVersion" value="3"');
    expect(html).toContain("API 키 (저장됨 — 비워 두면 그대로)");
    expect(html).toContain("저장된 키 지우기");
    expect(html).toContain('<fieldset class="flex flex-wrap gap-4" disabled="">');
    expect(html).not.toMatch(/name="apiKey"[^>]*value="/);
    expect(renderToStaticMarkup(createElement(ConnectionForm, { initial: null, secretBox: false })))
      .toContain("이 서버에는 키 암호화 설정이 없어 키를 저장할 수 없습니다");
  });
  it("작업 표: 줄마다 1·2·3순위(「연결 · 모델」)·지금 실제로 쓰는 모델·준비 상태; 저장 전에는 바뀐 것이 없다", () => {
    const html = renderToStaticMarkup(createElement(TaskRanksBoard, { lines: [line(), line({ task: "audit-review", label: "발행분 감사 · 직접 모델", group: "audit",
      rows: [], current: { labels: [], source: "등록부·env 기본값", notes: [], error: null, skip: "지금 꺼져 있습니다." }, sameAsCurrent: null, readiness: [] })],
      connections: [gpu], rows: line().rows }));
    expect(html).toContain("글 짓기·번역");
    expect(html).toContain("감사·보강");
    expect(html).toContain('aria-label="수집 소개 짓기 1순위"');
    expect(html).toContain(">gpu3090 · qwen3.8-flash-next</option>");
    expect(html).toContain(`name="rank1Connection" value="${GPU}"`);
    expect(html).toContain("저장한 순위 = 지금 동작");
    expect(html).toContain("저장한 순위의 계약·경로·장비가 있습니다.");
    expect(html).toContain("지금 꺼져 있습니다.");
    expect(html).toContain("바뀐 것이 없습니다.");
    expect(html).toContain("잡은 아직 이 순위를 읽지 않습니다");
    // 가져온 순위처럼 아직 없는 것이 있으면 바뀐 것이 없어도 다시 저장할 수 있다
    const pending = renderToStaticMarkup(createElement(TaskRanksBoard, { lines: [line({ readiness: [{ rank: 1, blocking: [], warnings: [],
      pending: ["1순위 qwen3.8-flash-next: crawl-tagline 엔진 직접 계약이 없습니다 — 이 줄을 저장하면 엔진을 확인하고 만듭니다."] }] })], connections: [gpu], rows: line().rows }));
    expect(pending).toContain("다시 저장해 빠진 것 만들기");
    expect(pending).toContain("엔진 직접 계약이 없습니다 — 이 줄을 저장하면");
    expect(pending).not.toContain("저장한 순위의 계약·경로·장비가 있습니다.");
  });
  it("가져오기 카드: 계획이 없으면 「계획 보기」만, 있으면 만들 연결·칸과 확인 칸", () => {
    expect(renderToStaticMarkup(createElement(TaskImportCard, { preview: null, confirmWord: "가져오기" }))).toContain("계획 보기");
    const html = renderToStaticMarkup(createElement(TaskImportCard, { confirmWord: "가져오기", preview: { hash: "f".repeat(64), error: null, servers: [],
      connectionLabels: { [`api:${gpu.baseUrl}`]: "gpu3090" }, plan: { warnings: ["경고 하나"], connections: [{ key: `api:${gpu.baseUrl}`, action: "create", id: null, label: "gpu3090",
        kind: "api", baseUrl: gpu.baseUrl, cliTool: null, cliModels: [], deviceId: "gpu3090-qwen", capacitySlots: 4, keyFrom: null, keyEnv: "AUDIT_SECOND_OPINION_API_KEY" }],
      slots: [{ task: "audit-review", slot: 1, action: "create", ranks: [{ rank: 1, connectionKey: `api:${gpu.baseUrl}`, model: "qwen3.8-flash-next", origin: "등록부·env 기본값", options: {} }] }] } } }));
    expect(html).toContain("연결 1개 만들기 · 순위 채울 칸 1개");
    expect(html).toContain("env AUDIT_SECOND_OPINION_API_KEY 를 옮김");
    expect(html).toContain("1. gpu3090 · <code>qwen3.8-flash-next</code>");
    expect(html).toContain("경고 — 경고 하나");
    expect(html).toContain("적용(쓰기 2건)");
  });
  it("서버 액션은 관리자가 아니면 아무것도 하지 않고 거절한다; 모든 쓰기는 쓰기 관문을 지난다", async () => {
    mocks.admin.mockResolvedValue(null);
    const form = new FormData();
    for (const action of [actions.saveAiConnectionAction, actions.readAiConnectionModelsAction, actions.deleteAiConnectionAction, actions.saveAiTaskRanksAction,
      actions.applyAiTaskImportAction]) expect(await action(null, form)).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    const source = readFileSync("app/(operator)/admin/models/tasks/actions.ts", "utf8");
    expect(source.match(/^export const \w+ = webWriteAction\(async function \w+/gm)).toHaveLength(5);
  });
});
