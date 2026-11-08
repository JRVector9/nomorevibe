import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(async () => null as { login: string } | null) }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { ConnectionForm, connectionLimitHint, type ConnectionLimitField } from "@/app/(operator)/admin/models/tasks/ConnectionForm";
import { TaskImportCard } from "@/app/(operator)/admin/models/tasks/TaskImportCard";
import * as actions from "@/app/(operator)/admin/models/tasks/actions";
import type { AiConnectionView } from "@/lib/operations/admin-ai-tasks";

const GPU = "11111111-1111-4111-8111-111111111111";
const gpu: AiConnectionView = { id: GPU, label: "gpu3090", kind: "api", baseUrl: "http://100.77.43.63:8090/v1", host: "100.77.43.63:8090", hasKey: true, cliTool: null,
  cliModels: [], models: [{ id: "qwen3.8-flash-next", maxModelLen: 131072 }], modelsReadAt: null, modelsError: null, deviceId: "gpu3090-qwen", capacitySlots: 4,
  contextTokens: null, enabled: true, version: 3, note: null, updatedBy: "t", updatedAt: "2026-11-02T00:00:00.000Z", cliVersion: null };
const limit: ConnectionLimitField = { deviceId: "gpu3090-qwen", current: 5, expectedVersion: 3, policyHash: "p".repeat(64), eligible: true, reason: null, sharedWith: [] };

describe("작업 배정 화면 · 연결 폼(LLM 운영)", () => {
  it("연결 폼: 고치기에서는 종류를 못 바꾸고, 저장된 키는 다시 보이지 않는다(「키 지우기」만)", () => {
    const html = renderToStaticMarkup(createElement(ConnectionForm, { initial: gpu, secretBox: true, limit }));
    expect(html).toContain('name="id" value="11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('name="expectedVersion" value="3"');
    expect(html).toContain("API 키 (저장됨 — 비워 두면 그대로)");
    expect(html).toContain("저장된 키 지우기");
    expect(html).toContain('<fieldset class="flex flex-wrap gap-4" disabled="">');
    expect(html).not.toMatch(/name="apiKey"[^>]*value="/);
    expect(renderToStaticMarkup(createElement(ConnectionForm, { initial: null, secretBox: false })))
      .toContain("이 서버에는 키 암호화 설정이 없어 키를 저장할 수 없습니다");
  });
  it("연결 폼에는 옛 「칸 수」 칸이 없다 — 동시 실행 한도는 장비 행 값 한 칸뿐이고, 한도를 모르면 장비 행을 바꾸지 않는다고 적는다", () => {
    const html = renderToStaticMarkup(createElement(ConnectionForm, { initial: gpu, secretBox: true, limit }));
    expect(html).not.toContain("칸 수(동시에 처리할 수)");
    expect(html).not.toContain("장비 행이 이미 있으면 그 값이 이깁니다");
    expect(html).toContain("동시 실행 한도(장비 행 · 실제 적용 값)");
    expect(html).toMatch(/name="capacitySlots"[^>]*value="5"/);
    expect(html.match(/name="capacitySlots"/g)).toHaveLength(1);
    expect(html).toContain('class="button primary"');
    expect(html).toContain(">저장하고 모델 읽기</button>");
    // 한도 값을 모를 때(넘기지 않음) — 연결의 값만 보이고 장비 행은 건드리지 않는다
    const unknown = renderToStaticMarkup(createElement(ConnectionForm, { initial: gpu, secretBox: true }));
    expect(unknown).toMatch(/name="capacitySlots"[^>]*value="4"/);
    expect(unknown).toContain("새 연결은 순위를 저장할 때 이 값으로 장비 행을 만듭니다");
    expect(unknown).toContain('href="/admin/models/llm"');
  });
  it("연결에 옛 칸 수가 남았으면(장비 행과 다름) 한도 칸 아래 한 줄 — 칸의 값으로 저장하면 무엇이 되는지", () => {
    const stale: ConnectionLimitField = { ...limit, stale: 4 };
    expect(connectionLimitHint(stale, "5")).toBe("저장하면 연결 값도 5(으)로 맞춰집니다(연결에 남은 옛 값 4).");
    expect(connectionLimitHint(stale, "6")).toBe("저장하면 연결과 장비 행 모두 6(으)로 바뀝니다.");
    expect(connectionLimitHint({ ...stale, eligible: false }, "6")).toBe("여기서는 장비 행을 바꾸지 못해 연결 값만 6(으)로 바뀝니다 — 맞추려면 5 그대로 저장하세요.");
    expect(connectionLimitHint(stale, "")).toBeNull();
    expect(connectionLimitHint(stale, "0")).toBeNull();
    expect(connectionLimitHint(limit, "5")).toBeNull();
    expect(connectionLimitHint({ ...stale, current: null }, "5")).toBeNull();
    const html = renderToStaticMarkup(createElement(ConnectionForm, { initial: gpu, secretBox: true, limit: stale }));
    expect(html).toContain('data-limit-hint="true">저장하면 연결 값도 5(으)로 맞춰집니다(연결에 남은 옛 값 4).</span>');
    // 고칠 칸은 id(conn-<연결>-<칸>)가 있고, ?fix 가 없으면 눈에 띄게 하지 않는다. 새 연결 폼에는 id 가 없다(행마다 겹치지 않게)
    for (const field of ["address", "key", "limit", "enabled"]) expect(html).toContain(`id="conn-${GPU}-${field}" data-fix-field="${field}">`);
    expect(html).not.toContain('data-fix="true"');
    expect(renderToStaticMarkup(createElement(ConnectionForm, { initial: null, secretBox: true }))).not.toContain("data-fix-field");
    expect(renderToStaticMarkup(createElement(ConnectionForm, { initial: gpu, secretBox: true, limit: stale, fix: "key" })))
      .toContain(`id="conn-${GPU}-key" data-fix-field="key" data-fix="true">`);
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
      actions.applyAiTaskImportAction, actions.hideAiConnectionModelAction, actions.clearUnreadAiTaskRanksAction])
      expect(await action(null, form)).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    mocks.admin.mockResolvedValue({ login: "operator" });
    // 연결 id 가 uuid 가 아니면 DB 에 묻지 않고 「찾지 못함」
    expect(await actions.readAiConnectionModelsAction(null, form)).toEqual({ issues: ["연결을 찾지 못했습니다(지워졌을 수 있습니다). 새로고침하세요."] });
    const del = new FormData(); del.set("id", "not-a-uuid"); del.set("expectedVersion", "1"); del.set("label", "x"); del.set("confirm", "x");
    expect(await actions.deleteAiConnectionAction(null, del)).toEqual({ issues: ["연결을 찾지 못했습니다(지워졌을 수 있습니다). 새로고침하세요."] });
    const source = readFileSync("app/(operator)/admin/models/tasks/actions.ts", "utf8");
    // 2026-11-08: 모델 빼기·되돌리기(hideAiConnectionModelAction)와 옛 순위 기록 지우기(clearUnreadAiTaskRanksAction) 둘이 더해져 7
    expect(source.match(/^export const \w+ = webWriteAction\(async function \w+/gm)).toHaveLength(7);
  });
});
