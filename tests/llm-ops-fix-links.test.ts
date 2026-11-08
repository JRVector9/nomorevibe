import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_TABS } from "@/app/(operator)/admin/status/action-links";
import { JOB_NAMES } from "@/lib/jobs/catalog";
import { aiTask } from "@/lib/llm/ai-tasks";
import type { AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { buildDashboardView, buildLlmOpsView, LLM_FIX_FIELDS, llmEditHref, llmFixField, llmLimitMismatchText, llmReasonFix, type LlmFix, type LlmOpsInput,
  type LlmOpsView } from "@/lib/operations/llm-ops-view";
import { modelCapacityPolicyHash } from "@/lib/llm/capacity";
import { buildAdminModelsObservation } from "@/lib/operations/admin-models-observation";
import { CLAUDE, GPU, LLM_NOW, llmClassifier, llmCliContracts, llmConnections, llmConveyor, llmDevices, llmJobs, llmMetrics, llmObservation, llmPolicy, llmRankRows,
  llmRequests, llmRuntime, M1, MLX, OPENCODE, SUPA } from "./fixtures/llm-ops";

/**
 * LLM 운영 행의 문제 표시 → 고칠 곳(2026-11-07 운영자 요청: 「해당 문제 클릭하면 해결할 수 있는 페이지로」).
 * 까닭마다 고치는 화면이 맞는지(운영자 문장 TEXT_RANK_UNUSABLE_TEXT 가 말하는 길), 그 주소의 경로·쿼리·앵커가 실제로 있는지 본다.
 */
const llm = (patch: Partial<LlmOpsInput> = {}) => buildLlmOpsView({ now: LLM_NOW, observation: llmObservation(), connections: llmConnections, rows: llmRankRows,
  executions: [], runtime: llmRuntime, jobs: llmJobs, cliContracts: llmCliContracts, classifier: llmClassifier, ...patch });
const conn = (id: string) => llmConnections.find(row => row.id === id)!;
const row = (view: LlmOpsView, key: string) => view.rows.find(entry => entry.key === key)!;
const edit = (id: string, field: string | null, label: string): LlmFix => ({ href: field ? `/admin/models/llm?edit=${id}&fix=${field}#conn-${id}-${field}` : `/admin/models/llm?edit=${id}#conn-${id}`, label });
const fresh = "2026-11-07T07:15:00.000Z";

describe("까닭 코드 → 고칠 곳", () => {
  const at = { connection: conn(GPU), task: "first-review", slot: 1 };
  const rank = (label: string): LlmFix => ({ href: "/admin/models/tasks#execution-first-review-1", label });
  const failures: LlmFix = { href: "/admin/models/history#failures", label: "실패 보기" };
  const retry: LlmFix = { href: "/admin/models/history#retry", label: "재실행 보기" };
  const contracts: LlmFix = { href: "/admin/models/contracts", label: "계약 보기" };
  it.each<[string, LlmFix | null]>([
    // 계약·용량 경로: 그 순위를 다시 저장하면 만든다(작업 배정의 그 줄)
    ["no_direct_contract", rank("순위 다시 저장")], ["cli_engine_contract_not_stored", rank("순위 다시 저장")], ["unmapped", rank("순위 다시 저장")],
    // 닫히거나 맞지 않는 계약: 모델 연결(계약) 화면
    ["provider_contract_unavailable", contracts], ["cli_contract_unavailable", contracts], ["gateway_auth", contracts], ["cli_engine_source_invalid", contracts],
    // 키: 연결 폼의 API 키 칸
    ["connection_key_missing", edit(GPU, "key", "키 넣기")], ["stored_key_unreadable", edit(GPU, "key", "키 다시 넣기")], ["key_unreadable", edit(GPU, "key", "키 다시 넣기")],
    ["engine_no_key", edit(GPU, "key", "키 확인")], ["http_401", edit(GPU, "key", "키 확인")], ["http_403", edit(GPU, "key", "키 확인")],
    // 서버·주소: 연결 폼의 주소 칸(저장하면 모델 목록을 다시 읽는다)
    ["engine_network", edit(GPU, "address", "다시 읽기")], ["unreachable", edit(GPU, "address", "다시 읽기")], ["http_503", edit(GPU, "address", "다시 읽기")],
    ["endpoint_invalid", edit(GPU, "address", "주소 고치기")],
    // 켜기·순위
    ["connection_disabled", edit(GPU, "enabled", "연결 켜기")], ["rank_disabled", rank("순위 켜기")], ["engine_model_unavailable", rank("순위 바꾸기")],
    ["connection_not_api", rank("순위 바꾸기")], ["cli_model_invalid", rank("순위 바꾸기")], ["no_task_models", rank("작업 배정")], ["all_ranks_unusable", rank("작업 배정")],
    // 장비·도우미
    ["device_unconfigured", { href: "/admin/models/devices#new", label: "장비 행 만들기" }], ["capacity", edit(GPU, "limit", "한도 보기")],
    ["queue_full", edit(GPU, "limit", "한도 보기")], ["helper_ineligible", { href: "/admin/models/helpers", label: "도우미 보기" }],
    // 경로 몫 가득(step 2) → 몫을 고치는 칸 배분 표(step 3)
    ["route_quota", { href: "/admin/models/allocation#allocation", label: "칸 배분" }],
    // 호출 결과: 실패는 최근 실패, 결과 모름은 재실행 대기
    ["engine_slow", failures], ["client_timeout", failures], ["invalid_output", failures], ["parse_failed", failures], ["engine_failed", failures], ["process_exit", failures],
    ["engine_unknown", retry], ["transport_unknown", retry], ["commit_unknown", retry], ["blocked_unconfirmed", retry],
    // 이 틱만 쉼 · 모르는 코드 — 링크를 지어내지 않는다
    ["model_paused", null], ["brand_new_code", null],
  ])("API 연결 · %s", (code, fix) => expect(llmReasonFix(code, at)).toEqual(fix));

  it("CLI 연결: 버전 문제는 CLI 버전 칸, 버전이 있는데 계약이 없으면 그 순위 다시 저장, 키·주소 까닭은 이 폼에 칸이 없어 링크 없음", () => {
    const claude = { connection: conn(CLAUDE), task: "second-review", slot: 2 };
    expect(llmReasonFix("cli_version_mismatch", claude)).toEqual(edit(CLAUDE, "version", "버전 고치기"));
    expect(llmReasonFix("cli_contract_missing", claude)).toEqual({ href: "/admin/models/tasks#execution-second-review-2", label: "순위 다시 저장" });
    expect(llmReasonFix("cli_contract_missing", { ...claude, connection: { ...conn(CLAUDE), cliVersion: null } })).toEqual(edit(CLAUDE, "version", "버전 적기"));
    for (const code of ["connection_key_missing", "engine_network", "http_401", "endpoint_invalid"]) expect(llmReasonFix(code, claude), code).toBeNull();
    // OpenCode 는 호스트에서 읽은 버전을 쓴다 — 연결을 다시 저장(버전 칸 없음), 호스트 주소·인증은 이 화면에서 못 고친다
    const opencode = { connection: conn(OPENCODE), task: "first-review", slot: 1 };
    expect(llmReasonFix("cli_version_mismatch", opencode)).toEqual(edit(OPENCODE, null, "연결 다시 저장"));
    expect(llmReasonFix("cli_engine_endpoint_invalid", opencode)).toBeNull();
    expect(llmReasonFix("cli_engine_auth_invalid", opencode)).toBeNull();
  });

  it("연결 행이 없는 CLI 도구: 연결 폼으로 보내지 않는다", () => {
    const none = { connection: null, task: null, slot: 1 };
    expect(llmReasonFix("connection_key_missing", none)).toBeNull();
    expect(llmReasonFix("cli_version_mismatch", none)).toEqual({ href: "/admin/models/contracts", label: "계약 보기" });
    expect(llmReasonFix("capacity", none)).toEqual({ href: "/admin/models/devices#devices", label: "장비 한도" });
    expect(llmReasonFix("no_direct_contract", none)).toEqual({ href: "/admin/models/tasks#tasks", label: "순위 다시 저장" });
  });

  it("?fix= 는 아는 칸만 받는다", () => {
    for (const field of LLM_FIX_FIELDS) expect(llmFixField(field)).toBe(field);
    expect(llmFixField("bogus")).toBeNull();
    expect(llmFixField("")).toBeNull();
    expect(llmFixField(null)).toBeNull();
    expect(llmEditHref(GPU)).toBe(`/admin/models/llm?edit=${GPU}#conn-${GPU}`);
  });
});

describe("LLM 운영 행 — 문제 표시와 고칠 곳", () => {
  it("한도 불일치: 「연결에 남은 옛 값 4 · 실제 적용 5」 — 그 연결 폼의 동시 실행 한도 칸으로(대시보드 할 일도 같은 말 · 같은 곳)", () => {
    expect(llmLimitMismatchText(4, 5)).toBe("연결에 남은 옛 값 4 · 실제 적용 5");
    const view = llm();
    const gpu = row(view, GPU);
    expect(gpu.capacity).toMatchObject({ text: "2 / 5", mismatch: true, note: "연결에 남은 옛 값 4 · 실제 적용 5", fix: edit(GPU, "limit", "맞추기") });
    expect(gpu.limitForm).toMatchObject({ current: 5, stale: 4 });
    expect(row(view, SUPA).capacity).toMatchObject({ note: "연결에 남은 옛 값 20 · 실제 적용 2", fix: edit(SUPA, "limit", "맞추기") });
    expect(row(view, SUPA).limitForm?.stale).toBe(20);
    expect(row(view, MLX).capacity).toMatchObject({ mismatch: false, note: null, fix: null });
    expect(row(view, MLX).limitForm?.stale).toBeNull();
    const todo = buildDashboardView({ now: LLM_NOW, observation: llmObservation(), conveyor: llmConveyor(), jobs: llmJobs, connections: llmConnections })
      .todos.find(entry => entry.id === `limit-${GPU}`)!;
    expect(todo.href).toBe(gpu.capacity!.fix!.href);
    expect(todo.detail).toContain(gpu.capacity!.note!);
    expect(JSON.stringify(view)).not.toContain("연결 폼");
  });

  it("장비 행이 없으면(정책 대체 한도) 장비 한도의 새 장비로", () => {
    const observation = buildAdminModelsObservation({ observedAt: LLM_NOW, control: { mode: "open", epoch: 4, revision: 12, policy: llmPolicy,
      policyHash: modelCapacityPolicyHash(llmPolicy), updatedAt: LLM_NOW }, metrics: llmMetrics, requests: llmRequests,
      devices: llmDevices.map(device => device.deviceId === "openai-cli" ? { ...device, source: "policy_fallback" as const } : device) });
    const view = llm({ observation });
    expect(row(view, "cli:codex-cli").capacity).toMatchObject({ note: "장비 행 없음 · 정책 대체 한도", fix: { href: "/admin/models/devices#new", label: "장비 행 만들기" } });
  });

  it("상태 까닭은 하나씩 고칠 곳을 든다 — 미확정은 재실행 대기, 실패는 최근 실패, 목록 못 읽음은 그 연결의 주소 칸", () => {
    const view = llm();
    expect(row(view, GPU).status.reasons).toEqual([{ text: "재실행 대기 1건", fix: { href: "/admin/models/history#retry", label: "재실행 보기" } }]);
    // 예전 한 줄(reason)은 그대로 — reasons 글자를 이은 것
    expect(row(view, OPENCODE).status.reason).toBe("1시간 정산 86 · 실패 2 · 시간 초과 1회(1차 AI 검수)");
    expect(row(view, OPENCODE).status.reasons.map(reason => reason.fix?.href)).toEqual(["/admin/models/history#failures", "/admin/models/history#failures"]);
    expect(row(view, M1).status).toMatchObject({ text: "목록 못 읽음", reasons: [{ text: "서버 응답 없음", fix: edit(M1, "address", "다시 읽기") }] });
    // 키 거절로 목록을 못 읽으면 키 칸
    const keyed = llm({ connections: llmConnections.map(entry => entry.id === M1 ? { ...entry, modelsError: "http_401" } : entry) });
    expect(row(keyed, M1).status.reasons[0]).toEqual({ text: "키 거절(HTTP 401)", fix: edit(M1, "key", "키 확인") });
    // 정상 행은 고칠 곳이 없다
    expect(row(view, MLX).status.reasons).toEqual([{ text: "1시간 정산 100", fix: null }]);
  });

  it("실행 쪽 순위 사정: 계약 없음은 작업 배정의 그 줄(다시 저장), 키 없음은 그 연결의 키 칸", () => {
    const view = llm({ runtime: {
      "crawl-tagline": { from: "job", at: fresh, served: [], unusable: [{ rank: 1, code: "no_direct_contract", text: "계약 없음", count: 9 }], degraded: null },
      "first-review": { from: "job", at: fresh, served: [], unusable: [{ rank: 2, code: "connection_key_missing", text: "키 없음", count: 3 }], degraded: null },
    } });
    expect(row(view, MLX).status.reasons[0]).toEqual({ text: "계약 없음 9회(수집 소개 짓기)",
      fix: { href: "/admin/models/tasks#execution-crawl-tagline-1", label: "순위 다시 저장" } });
    expect(row(view, GPU).status).toMatchObject({ level: "bad", text: "부르지 못함" });
    expect(row(view, GPU).status.reasons).toEqual([{ text: "키 없음 3회(1차 AI 검수)", fix: edit(GPU, "key", "키 넣기") },
      { text: "재실행 대기 1건", fix: { href: "/admin/models/history#retry", label: "재실행 보기" } }]);
  });

  it("잡이 멈춘 작업: 칩 옆에 잡 상태로 가는 링크, 행의 모든 작업이 멈췄으면 상태 까닭도 그 잡으로", () => {
    const view = llm();
    const verify = row(view, SUPA).tasks.find(chip => chip.task === "product-search-verify")!;
    expect(verify).toMatchObject({ paused: true, href: "/admin/models/tasks#execution-product-search-verify-1",
      fix: { href: "/admin/status?tab=jobs&job=product-search-verify", label: "잡 보기" } });
    expect(row(view, SUPA).tasks.find(chip => chip.task === "second-review")?.fix).toBeNull();
    expect(row(view, CLAUDE).tasks.find(chip => chip.task === "product-intro-check")?.fix).toEqual({ href: "/admin/status?tab=jobs&job=product-intro-check", label: "잡 보기" });
    const onlyPaused = llm({ rows: llmRankRows.filter(entry => !(entry.connectionId === SUPA && entry.task === "second-review")) });
    expect(row(onlyPaused, SUPA).status).toMatchObject({ level: "idle", text: "의도적 중지",
      reasons: [{ text: "잡 일시중지: 검색 키워드 검수", fix: { href: "/admin/status?tab=jobs&job=product-search-verify", label: "잡 보기" } }] });
  });

  it("꺼진 연결은 상태 칸에서 켜기로, 분류를 받지 않는 CLI 는 분류 설정으로, CLI 버전을 모르는 CLI 연결은 버전 칸으로", () => {
    const off = llm({ connections: llmConnections.map(entry => entry.id === GPU ? { ...entry, enabled: false } : entry) });
    expect(row(off, GPU).status.reasons).toEqual([{ text: "순위 선택지에서 빠져 있습니다(저장된 순위는 남음)", fix: edit(GPU, "enabled", "연결 켜기") }]);
    const refused = llm({ classifier: { ...llmClassifier, ready: false } });
    expect(row(refused, CLAUDE).status.reasons[0]).toEqual({ text: "connect 에이전트가 분류를 받지 않음", fix: { href: "/admin/status?tab=ai", label: "분류 설정" } });
    expect(row(refused, "cli:codex-cli").status.reasons[0].fix).toEqual({ href: "/admin/status?tab=ai", label: "분류 설정" });
    const noVersion = llm({ connections: llmConnections.map(entry => entry.id === CLAUDE ? { ...entry, cliVersion: null } : entry) });
    expect(row(noVersion, CLAUDE)).toMatchObject({ version: null, versionFix: edit(CLAUDE, "version", "버전 적기") });
    expect(row(llm(), CLAUDE).versionFix).toBeNull();
    expect(row(llm(), OPENCODE).versionFix).toBeNull();
  });
});

// ── 고칠 곳 주소가 실제로 닿는가 ──────────────────────────────────────────────────────────────────────

const root = path.resolve(__dirname, "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return existsSync(path.join(full, "page.tsx")) ? [] : routeFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}
const literalAnchors = (pathname: string) => new Set(routeFiles(path.join(root, "app", "(operator)", pathname))
  .flatMap(file => [...readFileSync(file, "utf8").matchAll(/\bid="([\w-]+)"/g)].map(match => match[1])));

function assertFixResolves(href: string, connections: readonly AiConnectionView[]) {
  const url = new URL(href, "http://localhost");
  const hash = decodeURIComponent(url.hash.slice(1));
  expect(existsSync(path.join(root, "app", "(operator)", url.pathname, "page.tsx")), `${href} — 경로가 없다`).toBe(true);
  if (url.pathname === "/admin/models/llm") {
    expect([...url.searchParams.keys()].every(key => key === "edit" || key === "fix"), href).toBe(true);
    const id = url.searchParams.get("edit")!;
    expect(connections.map(entry => entry.id), href).toContain(id);
    const field = url.searchParams.get("fix");
    if (field) {
      expect(LLM_FIX_FIELDS, href).toContain(field);
      expect(hash, href).toBe(`conn-${id}-${field}`);
      // 연결 폼이 그 칸에 id(conn-<연결>-<칸>)를 단다 — API 칸(주소·키)은 API 연결, CLI 버전 칸은 OpenCode 가 아닌 CLI 연결에만 있다
      expect(source("app/(operator)/admin/models/tasks/ConnectionForm.tsx"), href).toContain(`fixField("${field}")`);
      const kind = connections.find(entry => entry.id === id)!;
      if (field === "address" || field === "key") expect(kind.kind, href).toBe("api");
      if (field === "version") expect(kind.kind === "cli" && kind.cliTool !== "opencode", href).toBe(true);
    } else expect(hash, href).toBe(`conn-${id}`);
    return;
  }
  if (url.pathname === "/admin/models/tasks") {
    expect([...url.searchParams.keys()], href).toEqual([]);
    if (hash === "tasks") { expect([...literalAnchors(url.pathname)], href).toContain("tasks"); return; }
    const match = /^execution-(.+)-(\d+)$/.exec(hash);
    expect(match, `${href} — 작업 배정 줄 앵커가 아니다`).not.toBeNull();
    const task = aiTask(match![1]);
    expect(task, href).not.toBeNull();
    expect(Number(match![2]), href).toBeLessThanOrEqual(task!.slots);
    return;
  }
  if (url.pathname === "/admin/status") {
    expect(STATUS_TABS, href).toContain(url.searchParams.get("tab"));
    const job = url.searchParams.get("job");
    if (job !== null) expect(JOB_NAMES, href).toContain(job);
    expect(hash, href).toBe("");
    return;
  }
  expect([...url.searchParams.keys()], href).toEqual([]);
  if (hash) expect([...literalAnchors(url.pathname)], `${href} — 앵커가 없다`).toContain(hash);
}

describe("고칠 곳 주소가 받는 화면에 있다", () => {
  it("작업 배정 줄·LLM 운영 행 앵커는 화면이 그 모양으로 단다", () => {
    expect(source("lib/operations/llm-task-assign-view.ts")).toContain("anchor: `execution-${task.id}-${slot.slot}`");
    expect(source("app/(operator)/admin/models/tasks/TaskAssignBoard.tsx")).toContain("id={row.anchor}");
    expect(source("app/(operator)/admin/models/llm/LlmOpsList.tsx")).toContain("id={row.anchor}");
    expect(source("app/(operator)/admin/models/llm/page.tsx")).toContain("llmFixField(one(params.fix))");
  });

  it("화면 모형이 내는 고칠 곳과 까닭 표의 모든 주소가 경로·쿼리·앵커까지 닿는다", () => {
    const views = [llm(), llm({ classifier: { ...llmClassifier, ready: false } }),
      llm({ connections: llmConnections.map(entry => entry.id === GPU ? { ...entry, enabled: false } : entry.id === CLAUDE ? { ...entry, cliVersion: null } : entry) }),
      llm({ runtime: { "crawl-tagline": { from: "job", at: fresh, served: [], unusable: [{ rank: 1, code: "no_direct_contract", text: "", count: 1 }], degraded: null } } }),
      llm({ rows: llmRankRows.filter(entry => !(entry.connectionId === SUPA && entry.task === "second-review")) })];
    const fixes = views.flatMap(view => view.rows.flatMap(entry => [entry.capacity?.fix, entry.versionFix, ...entry.status.reasons.map(reason => reason.fix),
      ...entry.tasks.map(chip => chip.fix), ...Object.values(entry.modelTasks).flat().map(chip => chip.fix)]));
    const codes = ["no_direct_contract", "cli_contract_missing", "cli_version_mismatch", "provider_contract_unavailable", "connection_key_missing", "stored_key_unreadable",
      "engine_no_key", "http_401", "http_503", "connection_disabled", "rank_disabled", "connection_not_api", "engine_network", "endpoint_invalid", "device_unconfigured",
      "capacity", "helper_ineligible", "route_quota", "engine_slow", "engine_unknown", "no_task_models", "unmapped", "gateway_auth"];
    for (const connection of [conn(GPU), conn(CLAUDE), conn(OPENCODE), { ...conn(CLAUDE), cliVersion: null }, null])
      for (const task of [["first-review", 1], ["second-review", 3], [null, 1]] as const)
        for (const code of codes) fixes.push(llmReasonFix(code, { connection, task: task[0], slot: task[1] }));
    const hrefs = [...new Set(fixes.filter((fix): fix is LlmFix => !!fix).map(fix => fix.href))];
    expect(hrefs.length).toBeGreaterThan(15);
    for (const href of hrefs) assertFixResolves(href, llmConnections);
    // 검사기 자체의 확인 — 없는 칸·작업·잡·앵커는 걸러낸다
    expect(() => assertFixResolves(`/admin/models/llm?edit=${GPU}&fix=bogus#conn-${GPU}-bogus`, llmConnections)).toThrow();
    expect(() => assertFixResolves(`/admin/models/llm?edit=${CLAUDE}&fix=key#conn-${CLAUDE}-key`, llmConnections)).toThrow();
    expect(() => assertFixResolves("/admin/models/tasks#execution-first-review-2", llmConnections)).toThrow();
    expect(() => assertFixResolves("/admin/status?tab=jobs&job=no-such-job", llmConnections)).toThrow();
    expect(() => assertFixResolves("/admin/models/history#nowhere", llmConnections)).toThrow();
  });
});
