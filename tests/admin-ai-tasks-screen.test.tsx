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
import { TaskRanksBoard, clearConfirmText, type TaskRankLine } from "@/app/(operator)/admin/models/tasks/TaskRanksBoard";
import * as actions from "@/app/(operator)/admin/models/tasks/actions";
import type { AiConnectionView } from "@/lib/operations/admin-ai-tasks";

const GPU = "11111111-1111-4111-8111-111111111111";
const gpu: AiConnectionView = { id: GPU, label: "gpu3090", kind: "api", baseUrl: "http://100.77.43.63:8090/v1", host: "100.77.43.63:8090", hasKey: true, cliTool: null,
  cliModels: [], models: [{ id: "qwen3.8-flash-next", maxModelLen: 131072 }], modelsReadAt: null, modelsError: null, deviceId: "gpu3090-qwen", capacitySlots: 4,
  contextTokens: null, enabled: true, version: 3, note: null, updatedBy: "t", updatedAt: "2026-11-02T00:00:00.000Z", cliVersion: null };
const line = (patch: Partial<TaskRankLine> = {}): TaskRankLine => ({ task: "crawl-tagline", slot: 1, label: "수집 소개 짓기", group: "text", kind: "chat",
  description: "소개를 짓습니다.", accepts: "API 주소", revision: "a".repeat(64), rows: [{ task: "crawl-tagline", slot: 1, rank: 1, connectionId: GPU, model: "qwen3.8-flash-next",
    options: {}, enabled: true }], options: [{ provider: GPU, model: "qwen3.8-flash-next", label: "gpu3090 · qwen3.8-flash-next" }],
  current: { labels: ["gpu3090 · qwen3.8-flash-next"], source: "단계 풀", notes: [], error: null, skip: null }, sameAsCurrent: true,
  readiness: [{ rank: 1, blocking: [], warnings: [], pending: [] }], live: true, runtime: null, ...patch });

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
  it("작업 목록: 모델 순위·설정 상태를 한 행에서 비교하고, 저장 폼과 실행 쪽 설정은 같은 행에서 펼친다", () => {
    const html = renderToStaticMarkup(createElement(TaskRanksBoard, { lines: [line(), line({ task: "audit-review", label: "발행분 감사 · 직접 모델", group: "audit",
      rows: [], current: { labels: [], source: "등록부·env 기본값", notes: [], error: null, skip: "지금 꺼져 있습니다." }, sameAsCurrent: null, readiness: [], live: false })],
      connections: [gpu], rows: line().rows }));
    expect(html).toContain("글 짓기·번역");
    expect(html).toContain("감사·보강");
    expect(html).toContain('aria-label="수집 소개 짓기 1순위"');
    expect(html).toContain(">gpu3090 · qwen3.8-flash-next · 상태 확인 중</option>");
    // 같은 작업의 다른 순위에서도 같은 모델을 선택할 수 있다. 선택 자체는 공유 슬롯을 예약하지 않는다.
    expect(html).toContain(`<option value="${GPU}/qwen3.8-flash-next">gpu3090 · qwen3.8-flash-next · 상태 확인 중</option>`);
    expect(html).toContain(`name="rank1Connection" value="${GPU}"`);
    expect(html).toContain("저장 순위와 실행 설정 일치");
    expect(html).toContain("저장한 순위의 계약·경로·장비가 있습니다.");
    expect(html).toContain("지금 꺼져 있습니다.");
    // 설정 준비와 실제 실행 관측을 구분한다. 바뀐 것이 없으면 저장 버튼이 꺼져 있다.
    expect(html).toContain('data-status="ok">설정 준비됨</span>');
    expect(html).toContain('data-status="muted">실행 조건 확인</span>');
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>저장<\/button>/);
    expect(html).not.toContain("바뀐 것이 없습니다.");
    // 목록에서는 모델·상태를 항상 비교하며, 수정 폼은 닫힌 작업 행 안에 유지한다.
    expect(html).toContain('<details id="execution-crawl-tagline-1" class="mt-task-row">');
    expect(html).toContain('<details id="execution-audit-review-1" class="mt-task-row">');
    expect(html).toContain("모델 설정 · 순위별 표시");
    expect(html).toContain("최근 실행 관측 없음");
    expect(html.indexOf("gpu3090 · qwen3.8-flash-next")).toBeLessThan(html.indexOf('class="mt-task-editor"'));
    // 비라이브 감사 작업은 실제 적용 설정만 보여 주고 순위 저장 폼을 열지 않는다.
    expect(html.match(/<details class="text-\[13px\]"><summary class="cursor-pointer text-fg-3">자세히<\/summary>/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="발행분 감사 · 직접 모델 1순위"');
    expect(html.indexOf("실행 쪽 현재 설정")).toBeGreaterThan(html.indexOf("자세히</summary>"));
    // text 작업(PR B)은 실행 쪽이 순위를 읽는다 — 아직 돈 기록이 없으면 그렇게 보인다. 감사 작업은 아직 읽지 않는다(다음 단계)
    expect(html).toContain("대체 실행은 우선 모델 하나를 쓰고, 필요한 경우에만 다음 순위로 전환합니다. 순위마다 추가 검수하는 방식이 아닙니다.");
    // 감사 작업의 실제 적용 설정은 정본(/admin/audit)을 가리키고, 꺼진 실행 조건은 그대로 보인다.
    expect(html).toContain('href="/admin/audit"');
    expect(html).toContain('data-runtime="none"');
    expect(html).toContain("실행: 아직 이 순위로 돈 기록이 없습니다.");
    expect(html.match(/data-runtime=/g)).toHaveLength(1);
    // 가져온 순위처럼 아직 없는 것이 있으면 바뀐 것이 없어도 다시 저장할 수 있다
    const pending = renderToStaticMarkup(createElement(TaskRanksBoard, { lines: [line({ readiness: [{ rank: 1, blocking: [], warnings: [],
      pending: ["1순위 qwen3.8-flash-next: crawl-tagline 엔진 직접 계약이 없습니다 — 이 줄을 저장하면 엔진을 확인하고 만듭니다."] }] })], connections: [gpu], rows: line().rows }));
    expect(pending).toMatch(/<button type="submit"[^>]*>다시 저장<\/button>/);
    expect(pending).not.toMatch(/<button type="submit" disabled=""/);
    expect(pending).toContain('data-status="warn">빠진 것이 있습니다 — 다시 저장하면 만듭니다</span>');
    expect(pending).toContain("엔진 직접 계약이 없습니다 — 이 줄을 저장하면");
    expect(pending).not.toContain("저장한 순위의 계약·경로·장비가 있습니다.");
  });
  it("드롭다운은 서버마다 묶여 그 서버가 서비스하는 모델 이름만 나오고, 2차 투표자는 다른 투표자의 모델을 흐리게 둔다", () => {
    const options = [{ provider: GPU, model: "qwen3.8-flash-next", label: "gpu3090 · qwen3.8-flash-next", group: "gpu3090", text: "qwen3.8-flash-next" },
      { provider: GPU, model: "gpt-oss-120b", label: "gpu3090 · gpt-oss-120b", group: "gpu3090", text: "gpt-oss-120b" }];
    const voters = [{ task: "second-review", slot: 1, rank: 1, connectionId: GPU, model: "qwen3.8-flash-next", options: {}, enabled: true }];
    const html = renderToStaticMarkup(createElement(TaskRanksBoard, { lines: [line({ task: "second-review", slot: 2, label: "2차 AI 검수 · 투표자 2", group: "review",
      rows: [], options, current: null, sameAsCurrent: null, readiness: [], runtime: null })], connections: [gpu], rows: voters }));
    expect(html).toContain('aria-label="2차 AI 검수 · 투표자 2 1순위"');
    expect(html).toContain(`<optgroup label="gpu3090 · API"><option value="${GPU}/qwen3.8-flash-next" disabled="">qwen3.8-flash-next · 상태 확인 중 · 이 투표자/모델 조건에서 선택 불가</option>`
      + `<option value="${GPU}/gpt-oss-120b">gpt-oss-120b · 상태 확인 중</option></optgroup>`);
    expect(html).not.toContain(">gpu3090 · qwen3.8-flash-next");
    expect(html).toContain('data-status="bad">순위 없음 — 이 작업은 돌지 않습니다</span>');
  });
  it("순위를 모두 비우는 저장은 한 번 더 묻는다 — 실행 쪽이 읽는 작업은 멈춘다고 적는다", () => {
    expect(clearConfirmText({ label: "1차 AI 검수", live: true })).toContain("저장하면 이 작업은 모델을 부르지 않고 멈춥니다");
    expect(clearConfirmText({ label: "소개 검수", live: false })).toBe("「소개 검수」의 1·2·3순위를 모두 비웁니다. 정말 비울까요?");
  });
  it("한 줄 상태: 막힘·실행 멈춤·목록에 없는 저장 값·옛 설정으로 도는 작업·마지막 실행 건수", () => {
    const status = (patch: Partial<TaskRankLine>) => /data-status="(\w+)">([^<]*)</.exec(renderToStaticMarkup(createElement(TaskRanksBoard,
      { lines: [line(patch)], connections: [gpu], rows: line().rows })))!.slice(1);
    expect(status({ readiness: [{ rank: 1, blocking: ["막힘"], warnings: [], pending: [] }] })).toEqual(["bad", "쓸 수 없는 순위가 있습니다 — 자세히"]);
    expect(status({ runtime: { from: "job", at: "11-02", observedAt: "2026-11-02T00:00:00.000Z", fresh: true,
      served: [], unusable: [], degraded: { code: "all_ranks_unusable", detail: null } } }))
      .toEqual(["bad", "최근 실행 사용 불가"]);
    expect(status({ options: [{ provider: GPU, model: "qwen3.8-flash-next", label: "x", saved: true, group: "gpu3090", text: "qwen3.8-flash-next (목록에 없음)" }] }))
      .toEqual(["warn", "저장한 모델이 지금 서버 목록에 없습니다"]);
    expect(status({ readiness: [{ rank: 1, blocking: [], warnings: ["알림"], pending: [] }] })).toEqual(["warn", "알림이 있습니다 — 자세히"]);
    expect(status({ live: false })).toEqual(["muted", "저장됨 · 실행 쪽은 아직 옛 설정"]);
    const runtime: TaskRankLine["runtime"] = { from: "job", at: "11-02", observedAt: "2026-11-02T00:00:00.000Z", fresh: true,
      served: [{ rank: 1, count: 3 }, { rank: 2, count: 0 }], unusable: [], degraded: null };
    expect(status({ runtime })).toEqual(["ok", "설정 준비됨"]);
    const html = renderToStaticMarkup(createElement(TaskRanksBoard, { lines: [line({ runtime })], connections: [gpu], rows: line().rows }));
    expect(html).toContain('<span class="mt-task-runtime"><b>1순위 3건</b>');
  });
  it("실행 쪽 순위 사정: 순위마다 맡은 수와 아래 순위를 쓴 까닭, 제 일 못 한 틱을 보인다", () => {
    const served = renderToStaticMarkup(createElement(TaskRanksBoard, { lines: [line({ runtime: { from: "job", at: "11-02 12:00", served: [{ rank: 1, count: 3 },
      { rank: 2, count: 2 }, { rank: 3, count: 0 }], unusable: [{ rank: 1, code: "capacity", text: "포화(빈 칸 없음)", count: 2 }], degraded: null } })],
      connections: [gpu], rows: line().rows }));
    expect(served).toContain('data-runtime="job"');
    expect(served).toContain("실행(마지막 틱 · 11-02 12:00): 1순위 3건 · 2순위 2건");
    expect(served).not.toContain("3순위 0건");
    expect(served).toContain("아래 순위를 쓴 까닭 — 1순위: 포화(빈 칸 없음) ×2");
    expect(served).not.toContain("제 일 못 함");
    // 웹(검색어 번역)의 마지막 요청 — 모든 순위를 쓸 수 없었으면 맡은 순위 없음과 그 까닭
    const degraded = renderToStaticMarkup(createElement(TaskRanksBoard, { lines: [line({ task: "search-query-translate", label: "검색어 번역", runtime: { from: "web",
      at: "11-02 12:01", served: [], unusable: [{ rank: 1, code: "provider_contract_unavailable", text: "전송 계약이 닫힘", count: 1 }],
      degraded: { code: "all_ranks_unusable", detail: "검색어 번역: 1순위 gpu3090 · qwen3.8-flash-next: 전송 계약이 닫힘" } } })], connections: [gpu], rows: line().rows }));
    expect(degraded).toContain('data-runtime="web"');
    expect(degraded).toContain("실행(이 웹 프로세스의 마지막 요청 · 11-02 12:01): 맡은 순위 없음");
    expect(degraded).toContain("쉰 순위 — 1순위: 전송 계약이 닫힘");
    expect(degraded).toContain("제 일 못 함 <code>all_ranks_unusable</code> — 검색어 번역: 1순위 gpu3090 · qwen3.8-flash-next: 전송 계약이 닫힘");
  });
  it("가져오기 카드: 계획이 없으면 「계획 보기」만, 있으면 만들 연결·칸과 확인 칸 — 키 경고는 경고 맨 앞 줄이고 적용 버튼은 막지 않는다", () => {
    expect(renderToStaticMarkup(createElement(TaskImportCard, { preview: null, confirmWord: "가져오기" }))).toContain("계획 보기");
    const keyWarning = "gpu3090: 키를 옮기지 못해 키 없이 만듭니다(이 프로세스에 키 암호화 설정(NMV_SECRET_BOX_KEY)이 없음) — 이 연결은 키가 채워질 때까지 부르지 않고 다음 순위로 넘깁니다.";
    const html = renderToStaticMarkup(createElement(TaskImportCard, { confirmWord: "가져오기", preview: { hash: "f".repeat(64), error: null, servers: [], keyWarnings: [keyWarning],
      connectionLabels: { [`api:${gpu.baseUrl}`]: "gpu3090" }, plan: { warnings: [keyWarning, "경고 하나"], connections: [{ key: `api:${gpu.baseUrl}`, action: "create", id: null, label: "gpu3090",
        kind: "api", baseUrl: gpu.baseUrl, cliTool: null, cliModels: [], deviceId: "gpu3090-qwen", capacitySlots: 4, keyFrom: null, keyEnv: "AUDIT_SECOND_OPINION_API_KEY" }],
      slots: [{ task: "audit-review", slot: 1, action: "create", ranks: [{ rank: 1, connectionKey: `api:${gpu.baseUrl}`, model: "qwen3.8-flash-next", origin: "등록부·env 기본값", options: {} }] }] } } }));
    expect(html).toContain("연결 1개 만들기 · 순위 채울 칸 1개");
    expect(html).toContain("env AUDIT_SECOND_OPINION_API_KEY 를 옮김");
    expect(html).toContain("1. gpu3090 · <code>qwen3.8-flash-next</code>");
    expect(html).toContain("경고 — 경고 하나");
    expect(html.indexOf(`경고 — ${keyWarning}`)).toBeGreaterThan(-1);
    expect(html.indexOf(`경고 — ${keyWarning}`)).toBeLessThan(html.indexOf("경고 — 경고 하나"));
    expect(html).toContain("적용(쓰기 2건)");
    expect(html).not.toMatch(/<button type="submit" disabled=""/);
  });
  it("서버 액션은 관리자가 아니면 아무것도 하지 않고 거절한다; 모든 쓰기는 쓰기 관문을 지난다", async () => {
    mocks.admin.mockResolvedValue(null);
    const form = new FormData();
    for (const action of [actions.saveAiConnectionAction, actions.readAiConnectionModelsAction, actions.deleteAiConnectionAction, actions.saveAiTaskRanksAction,
      actions.applyAiTaskImportAction]) expect(await action(null, form)).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    mocks.admin.mockResolvedValue({ login: "operator" });
    // 연결 id 가 uuid 가 아니면 DB 에 묻지 않고 「찾지 못함」
    expect(await actions.readAiConnectionModelsAction(null, form)).toEqual({ issues: ["연결을 찾지 못했습니다(지워졌을 수 있습니다). 새로고침하세요."] });
    const del = new FormData(); del.set("id", "not-a-uuid"); del.set("expectedVersion", "1"); del.set("label", "x"); del.set("confirm", "x");
    expect(await actions.deleteAiConnectionAction(null, del)).toEqual({ issues: ["연결을 찾지 못했습니다(지워졌을 수 있습니다). 새로고침하세요."] });
    const source = readFileSync("app/(operator)/admin/models/tasks/actions.ts", "utf8");
    expect(source.match(/^export const \w+ = webWriteAction\(async function \w+/gm)).toHaveLength(5);
  });
});
