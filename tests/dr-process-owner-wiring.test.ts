import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { consumerProcessOwner, superviseWorker } from "@/scripts/worker-supervisor";
import { runPipelineFirstConsumer } from "@/scripts/pipeline-first-consumer";
import { runPipelineConsumer } from "@/scripts/pipeline-consumer";

// PR15d D11 연결: 슈퍼바이저가 기록한 프로세스 그룹 owner 가 child 의 장부 owner(item owner)·HTTP hop boot 와 같아야 그룹 종료 근거가 그 행을 덮는다.
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn() }));
vi.mock("@/lib/operations/observations", () => ({ observeService: vi.fn(async () => {}) }));
const seen = vi.hoisted(() => ({ owners: [] as unknown[] }));
vi.mock("@/scripts/worker", () => ({ withRuntimeProcess: async (_role: string, run: (signal: AbortSignal, report: () => void) => Promise<unknown>) =>
  run(new AbortController().signal, () => {}), interruptibleSleep: vi.fn() }));
vi.mock("@/lib/crawl/consumers/first", () => ({ runFirstReviewConsumer: async (input: { owner: unknown }) => { seen.owners.push(input.owner); return { claimed: 0 }; } }));
vi.mock("@/lib/crawl/consumers/second", () => ({ runSecondReviewConsumer: async (input: { owner: unknown }) => { seen.owners.push(input.owner); return { claimed: 0 }; } }));

const directory = mkdtempSync(join(tmpdir(), "pr15d-owner-"));
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
const limits = { heartbeatMs: 60_000, progressMs: 90_000, jobMs: 180_000, drainMs: 5_000 };
const boot = "0a6bd6a3-6c2a-4f6e-9a39-2d6f7b0e5c21", ticket = { seq: 1, runId: "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11" }, pid = 424_243;
afterEach(() => { vi.restoreAllMocks(); vi.mocked(childProcess.spawn).mockReset(); seen.owners = []; });

async function spawnedEnv(processGroup?: NonNullable<Parameters<typeof superviseWorker>[1]>["processGroup"]) {
  vi.mocked(childProcess.spawn).mockReset();
  const child = Object.assign(new childProcess.ChildProcess(), { pid, kill: vi.fn() });
  let env: NodeJS.ProcessEnv | undefined;
  vi.mocked(childProcess.spawn).mockImplementation(((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { env = options.env; return child; }) as never);
  let gone = false;
  vi.spyOn(process, "kill").mockImplementation(((_target: number, signal?: string | number) => {
    if (signal === "SIGKILL") gone = true; if (signal === 0 && gone) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); return true; }) as typeof process.kill);
  const running = superviseWorker("crawler", { once: true, closeDbOnExit: false, healthPath: join(directory, `${Math.random()}.json`), limits, processGroup });
  await vi.waitFor(() => expect(childProcess.spawn).toHaveBeenCalledOnce());
  child.emit("exit", 0); await running;
  return env!;
}

it("passes the recorded owner (instance, boot) to the child env only, never to the parent's own env", async () => {
  const group = { owner: { instanceId: "m3-reviewer", bootId: boot }, intent: vi.fn(async () => ticket), spawned: vi.fn(async () => {}), exited: vi.fn(async () => {}) };
  const env = await spawnedEnv(group);
  expect(env).toMatchObject({ PROCESS_GROUP_OWNER_INSTANCE_ID: "m3-reviewer", PROCESS_GROUP_OWNER_BOOT_ID: boot });
  expect(process.env.PROCESS_GROUP_OWNER_BOOT_ID).toBeUndefined(); expect(process.env.PROCESS_GROUP_OWNER_INSTANCE_ID).toBeUndefined();
  // 기록기가 없으면(직접 실행·scheduler) env 도 없다 — 그 child 의 행은 근거 없는 owner 로 남는다.
  const plain = await spawnedEnv();
  expect(plain.PROCESS_GROUP_OWNER_BOOT_ID).toBeUndefined(); expect(plain.PROCESS_GROUP_OWNER_INSTANCE_ID).toBeUndefined();
});

it("records a process-group owner for enabled AI1/AI2 consumers only, keyed by the item-consumer instance", () => {
  expect(consumerProcessOwner(undefined, { PIPELINE_ITEM_CONSUMER_VERSION: "1", PIPELINE_ITEM_CONSUMER_INSTANCE_ID: "c1" })).toBeNull();
  expect(consumerProcessOwner("ai1", { PIPELINE_ITEM_CONSUMER_INSTANCE_ID: "c1" })).toBeNull(); // 기본 비활성은 DB 를 건드리지 않는다
  const first = consumerProcessOwner("ai1", { PIPELINE_ITEM_CONSUMER_VERSION: "1", PIPELINE_ITEM_CONSUMER_INSTANCE_ID: "c1" });
  const second = consumerProcessOwner("ai2", { PIPELINE_ITEM_CONSUMER_VERSION: "1", PIPELINE_ITEM_CONSUMER_INSTANCE_ID: "c1" });
  expect(first).toEqual({ instanceId: "c1", bootId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(second!.bootId).not.toBe(first!.bootId);
  expect(() => consumerProcessOwner("ai2", { PIPELINE_ITEM_CONSUMER_VERSION: "1" })).toThrow();
});

it("AI1/AI2 consumers use the supervisor-recorded boot as item owner when it names their instance, else a fresh boot", async () => {
  // AI1 은 health 경로 규칙상 SERVICE_INSTANCE_ID 가 ai1-consumer-* 여야 한다(기존 규칙 그대로).
  const first = { PIPELINE_ITEM_CONSUMER_VERSION: "1", PIPELINE_ITEM_CONSUMER_INSTANCE_ID: "ai1-consumer-unit", SERVICE_INSTANCE_ID: "ai1-consumer-unit" };
  const second = { PIPELINE_ITEM_CONSUMER_VERSION: "1", PIPELINE_ITEM_CONSUMER_INSTANCE_ID: "ai2-consumer-unit", SERVICE_INSTANCE_ID: "ai2-consumer-unit" };
  await runPipelineFirstConsumer(["--once"], { ...first, PROCESS_GROUP_OWNER_INSTANCE_ID: "ai1-consumer-unit", PROCESS_GROUP_OWNER_BOOT_ID: boot });
  await runPipelineConsumer(["--stage=ai2", "--once"], { ...second, PROCESS_GROUP_OWNER_INSTANCE_ID: "ai2-consumer-unit", PROCESS_GROUP_OWNER_BOOT_ID: boot });
  await runPipelineConsumer(["--stage=ai2", "--once"], { ...second, PROCESS_GROUP_OWNER_INSTANCE_ID: "other", PROCESS_GROUP_OWNER_BOOT_ID: boot });
  await runPipelineFirstConsumer(["--once"], first);
  expect(seen.owners[0]).toEqual({ instanceId: "ai1-consumer-unit", bootId: boot });
  expect(seen.owners[1]).toEqual({ instanceId: "ai2-consumer-unit", bootId: boot });
  expect(seen.owners[2]).toMatchObject({ instanceId: "ai2-consumer-unit" }); expect(seen.owners[3]).toMatchObject({ instanceId: "ai1-consumer-unit" });
  for (const value of seen.owners.slice(2)) expect((value as { bootId: string }).bootId).not.toBe(boot);
});
