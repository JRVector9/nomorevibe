import { describe, expect, it, vi } from "vitest";
import { saveAssignmentChanges } from "@/lib/operations/model-assignment-save";

const changes = () => [{ kind: "execution" as const, form: new FormData() }, { kind: "ranks" as const, form: new FormData() }];

describe("assignment save responses in the flow panel and models drawer", () => {
  it("does not call a lost response a rejected write, retry it, or proceed to the next write; refreshes authoritative values", async () => {
    const actions = { execution: vi.fn().mockRejectedValue(new Error("connection closed after commit")), ranks: vi.fn() };
    const refresh = vi.fn();
    const results = await saveAssignmentChanges(changes(), actions, refresh);
    expect(results).toEqual([expect.objectContaining({ kind: "execution", ok: false, unconfirmed: true })]);
    expect(results[0].issues[0]).toContain("적용됐을 수 있으니");
    expect(actions.execution).toHaveBeenCalledTimes(1);
    expect(actions.ranks).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("preserves the server's actual rejection and refreshes even without a successful write", async () => {
    const actions = { execution: vi.fn().mockResolvedValue({ issues: ["서버 모델 목록이 바뀌었습니다."] }), ranks: vi.fn() };
    const refresh = vi.fn();
    const results = await saveAssignmentChanges(changes(), actions, refresh);
    expect(results[0]).toMatchObject({ ok: false, unconfirmed: false, issues: ["서버 모델 목록이 바뀌었습니다."] });
    expect(actions.ranks).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([null, undefined])("treats an absent response (%s) as unconfirmed", async response => {
    const actions = { execution: vi.fn().mockResolvedValue(response), ranks: vi.fn() };
    const results = await saveAssignmentChanges(changes(), actions, vi.fn());
    expect(results[0]).toMatchObject({ ok: false, unconfirmed: true });
    expect(actions.ranks).not.toHaveBeenCalled();
  });

  it("keeps confirmed partial saves when the next response is lost", async () => {
    const actions = { execution: vi.fn().mockResolvedValue({ ok: true, message: "실행 방식 저장", warnings: ["장비 한도 대기"] }),
      ranks: vi.fn().mockRejectedValue(new Error("response lost")) };
    const results = await saveAssignmentChanges(changes(), actions, vi.fn());
    expect(results[0]).toMatchObject({ kind: "execution", ok: true, warnings: ["장비 한도 대기"] });
    expect(results[1]).toMatchObject({ kind: "ranks", ok: false, unconfirmed: true });
    expect(actions.execution.mock.invocationCallOrder[0]).toBeLessThan(actions.ranks.mock.invocationCallOrder[0]);
  });
});
