import { afterEach, describe, expect, it, vi } from "vitest";

// 가져오기 거절(2026-11-02): 스크립트는 앱과 같은 함수를 부른다 — 그 함수의 거절을 0 이 아닌 종료 코드로 돌려주는지만 본다(함수 자체는 통합 시험)
const repo = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn() }));
vi.mock("@/lib/operations/admin-ai-tasks-repository", () => ({ previewAiTaskImport: repo.preview, applyAiTaskImport: repo.apply,
  readAiTasksAdminView: vi.fn(), saveAiTaskRanks: vi.fn() }));

import { parseAiTaskRanksArgs, runAiTaskRanks } from "../scripts/ops/ai-task-ranks";

describe("작업 ↔ 모델 운영 스크립트 인자", () => {
  it("명령·hash·작업 목록을 읽는다", () => {
    expect(parseAiTaskRanksArgs(["apply", "--hash=" + "a".repeat(64), "--operator=claude"])).toMatchObject({ command: "apply", hash: "a".repeat(64), operator: "claude" });
    expect(parseAiTaskRanksArgs(["resave", "--operator=x", "--task=crawl-agent-review, second-review"]).tasks).toEqual(["crawl-agent-review", "second-review"]);
    expect(parseAiTaskRanksArgs(["status", "--json"])).toMatchObject({ command: "status", json: true, tasks: null });
  });
});

describe("set 명령 인자", () => {
  it("--rankN=<연결>|<모델> 을 순서대로 읽고 모양이 틀리면 빈칸으로 둔다(저장 검증이 막는다)", () => {
    const args = parseAiTaskRanksArgs(["set", "--operator=x", "--task=second-review", "--slot=1", "--rank1=gpu3090|qwen3.8-flash-next", "--rank2=bad"]);
    expect(args).toMatchObject({ slot: "1", tasks: ["second-review"] });
    expect(args.ranks).toEqual([{ connection: "gpu3090", model: "qwen3.8-flash-next" }, null]);
  });
});

describe("가져오기 키 경고 → 종료 코드(2026-11-02 사람 결정: 키가 없어도 가져오기·배포는 멈추지 않는다)", () => {
  afterEach(() => { vi.restoreAllMocks(); repo.preview.mockReset(); repo.apply.mockReset(); });
  const WARNED = "m3-mlx: 키를 옮기지 못해 키 없이 만들었습니다(이 프로세스에 키 암호화 설정(NMV_SECRET_BOX_KEY)이 없음) — 이 연결은 키가 채워질 때까지 부르지 않고 다음 순위로 넘깁니다.";
  it("apply: 키 없이 만들었다는 경고가 있어도 성공이면 0 — 결과 JSON 은 stdout 한 줄, 경고는 stderr 「경고 …」", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {}), err = vi.spyOn(console, "error").mockImplementation(() => {});
    repo.apply.mockResolvedValue({ ok: true, connections: 1, slots: 1, skipped: 0, warnings: [WARNED] });
    expect(await runAiTaskRanks(["apply", `--hash=${"a".repeat(64)}`, "--operator=claude"])).toBe(0);
    expect(repo.apply).toHaveBeenCalledWith("a".repeat(64), "claude");
    expect(log.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ ok: true, warnings: [WARNED] });
    expect(err.mock.calls.flat()).toContain(`경고 ${WARNED}`);
    // 진짜 실패(계획이 바뀜 등)는 여전히 1
    repo.apply.mockResolvedValue({ ok: false, issues: ["ai_task_import_plan_changed"] });
    expect(await runAiTaskRanks(["apply", `--hash=${"a".repeat(64)}`, "--operator=claude"])).toBe(1);
  });
  it("preview: 키 경고만 있으면 0(경고 맨 앞 줄에 보임), 계획을 못 만들면 1", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const plan = { connections: [], slots: [], warnings: [WARNED] };
    repo.preview.mockResolvedValue({ hash: "b".repeat(64), plan, servers: [], error: null, connectionLabels: {}, keyWarnings: [WARNED] });
    expect(await runAiTaskRanks(["preview"])).toBe(0);
    expect(log.mock.calls.flat()).toContain(`경고 ${WARNED}`);
    repo.preview.mockResolvedValue({ hash: null, plan: null, servers: [], error: "db_unavailable", connectionLabels: {}, keyWarnings: [] });
    expect(await runAiTaskRanks(["preview"])).toBe(1);
  });
});
