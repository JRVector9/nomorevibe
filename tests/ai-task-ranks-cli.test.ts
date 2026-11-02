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

describe("가져오기 거절 → 종료 코드", () => {
  afterEach(() => { vi.restoreAllMocks(); repo.preview.mockReset(); repo.apply.mockReset(); });
  const REFUSED = "가져오기를 할 수 없습니다 — 키가 필요한 연결(m3-mlx)의 키를 옮겨야 하는데 이 프로세스에는 키 암호화 설정(NMV_SECRET_BOX_KEY)이 없습니다.";
  it("apply: 키를 옮길 수 없어 거절되면(아무것도 쓰지 않음) 1 과 그 까닭을 찍는다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    repo.apply.mockResolvedValue({ ok: false, issues: [REFUSED] });
    expect(await runAiTaskRanks(["apply", `--hash=${"a".repeat(64)}`, "--operator=claude"])).toBe(1);
    expect(repo.apply).toHaveBeenCalledWith("a".repeat(64), "claude");
    expect(log.mock.calls.flat().join("\n")).toContain(REFUSED);
    repo.apply.mockResolvedValue({ ok: true, connections: 1, slots: 1, skipped: 0, warnings: [] });
    expect(await runAiTaskRanks(["apply", `--hash=${"a".repeat(64)}`, "--operator=claude"])).toBe(0);
  });
  it("preview: 적용이 거절될 계획이면 1(까닭은 경고 맨 앞 줄), 아니면 0", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const plan = { connections: [], slots: [], warnings: [REFUSED] };
    repo.preview.mockResolvedValue({ hash: "b".repeat(64), plan, servers: [], error: null, connectionLabels: {}, blocked: [REFUSED] });
    expect(await runAiTaskRanks(["preview"])).toBe(1);
    expect(log.mock.calls.flat()).toContain(`경고 ${REFUSED}`);
    repo.preview.mockResolvedValue({ hash: "b".repeat(64), plan: { ...plan, warnings: [] }, servers: [], error: null, connectionLabels: {}, blocked: [] });
    expect(await runAiTaskRanks(["preview"])).toBe(0);
  });
});
