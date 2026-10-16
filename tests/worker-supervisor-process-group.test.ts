import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { superviseWorker } from "@/scripts/worker-supervisor";

// D11: 슈퍼바이저는 spawn 전에 의도를 commit 하고, 그룹 SIGKILL 뒤 ESRCH 를 직접 본 경우에만 종료를 기록한다.
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn() }));
vi.mock("@/lib/operations/observations", () => ({ observeService: vi.fn(async () => {}) }));

const ticket = { seq: 1, runId: "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11" }, pid = 424_242;
const directory = mkdtempSync(join(tmpdir(), "d11-supervisor-"));
const limits = { heartbeatMs: 60_000, progressMs: 90_000, jobMs: 180_000, drainMs: 5_000 };
const esrch = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
afterEach(() => { vi.restoreAllMocks(); vi.mocked(childProcess.spawn).mockReset(); vi.useRealTimers(); });
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));

function recorder(order: string[], change: Partial<Record<"intent" | "spawned" | "exited", () => Promise<unknown>>> = {}) {
  return {
    intent: vi.fn(async () => { order.push("intent"); if (change.intent) await change.intent(); return ticket; }),
    spawned: vi.fn(async () => { order.push("spawned"); if (change.spawned) await change.spawned(); }),
    exited: vi.fn(async () => { order.push("exited"); if (change.exited) await change.exited(); }),
  };
}
function fakeChild(order: string[]) {
  const child = Object.assign(new childProcess.ChildProcess(), { pid, kill: vi.fn() });
  vi.mocked(childProcess.spawn).mockImplementation(() => { order.push("spawn"); return child; });
  return child;
}

it("refuses to spawn when the spawn intent cannot be committed", async () => {
  const order: string[] = [], group = recorder(order, { intent: async () => { throw new Error("db_down"); } });
  fakeChild(order);
  expect(await superviseWorker("crawler", { once: true, closeDbOnExit: false, healthPath: join(directory, "a.json"), limits, processGroup: group })).toBe(1);
  expect(childProcess.spawn).not.toHaveBeenCalled();
  expect(order).toEqual(["intent"]); expect(group.spawned).not.toHaveBeenCalled(); expect(group.exited).not.toHaveBeenCalled();
});

it("commits the intent before spawn and records exit only after observing ESRCH for the whole group", async () => {
  const order: string[] = [], group = recorder(order), child = fakeChild(order);
  let gone = false;
  const kill = vi.spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
    order.push(`kill:${target}:${signal}`);
    if (signal === "SIGKILL") gone = true;
    if (signal === 0 && gone) throw esrch();
    return true;
  }) as typeof process.kill);
  const running = superviseWorker("crawler", { once: true, closeDbOnExit: false, healthPath: join(directory, "b.json"), limits, processGroup: group });
  await vi.waitFor(() => expect(group.spawned).toHaveBeenCalledWith(ticket, pid));
  expect(order.slice(0, 3)).toEqual(["intent", "spawn", "spawned"]);
  child.emit("exit", 0);
  expect(await running).toBe(0);
  expect(group.exited).toHaveBeenCalledWith(ticket, pid);
  expect(order.indexOf(`kill:${-pid}:SIGKILL`)).toBeLessThan(order.indexOf(`kill:${-pid}:0`));
  expect(order.at(-1)).toBe("exited");
  expect(kill).toHaveBeenCalledWith(-pid, 0);
});

it("does not record an exit while any member of the group can still be signalled", async () => {
  vi.useFakeTimers();
  const order: string[] = [], group = recorder(order), child = fakeChild(order);
  vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
  const running = superviseWorker("crawler", { once: true, closeDbOnExit: false, healthPath: join(directory, "c.json"), limits, processGroup: group });
  await vi.waitFor(() => expect(group.spawned).toHaveBeenCalled());
  child.emit("exit", 0);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await running).toBe(1);
  expect(group.exited).not.toHaveBeenCalled();
});

it("keeps the running child when only the spawned record fails, and then never claims its exit", async () => {
  const order: string[] = [], group = recorder(order, { spawned: async () => { throw new Error("db_blip"); } }), child = fakeChild(order);
  let gone = false;
  vi.spyOn(process, "kill").mockImplementation(((_target: number, signal?: string | number) => {
    if (signal === "SIGKILL") gone = true; if (signal === 0 && gone) throw esrch(); return true; }) as typeof process.kill);
  const running = superviseWorker("crawler", { once: true, closeDbOnExit: false, healthPath: join(directory, "d.json"), limits, processGroup: group });
  await vi.waitFor(() => expect(group.spawned).toHaveBeenCalled());
  expect(child.kill).not.toHaveBeenCalled();
  child.emit("exit", 0);
  expect(await running).toBe(0);
  expect(group.exited).not.toHaveBeenCalled();
});
