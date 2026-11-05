import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { db } from "@/lib/db";
import { aiConnections, aiTaskModels } from "@/lib/db/schema";
import { buildStationLlm } from "@/lib/operations/conveyor-llm";
import { readLlmInputs } from "@/lib/operations/conveyor-llm-read";
import { ensureSchema } from "./setup";

/**
 * 전체 흐름 칸의 모델 읽기 — 설정한 순위·연결·1시간 장부·실행 쪽 사정을 사설 시험 DB 에서 한 바퀴 읽는다(읽기만).
 * 장부(model_capacity_requests)는 정산 행을 넣으려면 종결 증거 CHECK 여럿을 맞춰야 하고, 다른 시험이 장부가 비어 있어야 시작하므로 여기서는 넣지 않는다 —
 * 집계 SQL 이 이 스키마에서 돌고(빈 결과), 읽기 전용 TX 로 열리는 것만 본다. 장부 → 모델 맞추기는 tests/conveyor-llm.test.tsx 가 정한 입력으로 본다.
 */
const run = randomUUID();
const connectionId = randomUUID();
const label = `it-llm-${run.slice(0, 8)}`;

beforeAll(async () => {
  ensureSchema();
  await db.insert(aiConnections).values({ id: connectionId, label, kind: "api", baseUrl: `http://it-llm-${run.slice(0, 8)}.test/v1`, deviceId: "it-llm", updatedBy: "it" });
  await db.insert(aiTaskModels).values({ task: "screen-review", slot: 8, rank: 1, connectionId, model: "it-model", updatedBy: "it" });
});
afterAll(async () => {
  await db.delete(aiTaskModels).where(eq(aiTaskModels.connectionId, connectionId));
  await db.delete(aiConnections).where(eq(aiConnections.id, connectionId));
});

it("reads the configured ranks and connections without opening keys, and the 1-hour ledger aggregate runs read-only", async () => {
  const inputs = await readLlmInputs(new Date().toISOString());
  const connection = inputs.connections?.find((row) => row.id === connectionId);
  expect(connection).toEqual({ id: connectionId, label, kind: "api", baseUrl: `http://it-llm-${run.slice(0, 8)}.test/v1`, cliTool: null, hasKey: false, enabled: true });
  expect(inputs.rows).toContainEqual({ task: "screen-review", slot: 8, rank: 1, connectionId, model: "it-model", enabled: true,
    updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  expect(Array.isArray(inputs.used)).toBe(true);
  expect(inputs.runtime).not.toBeNull();
  // 읽은 입력으로 칸 답을 만들 수 있다 — 벨트 밖 작업의 행이 섞여도 칸은 자기 작업만 본다
  const models = buildStationLlm(inputs);
  expect(models.judge.kind).toBe("none");
  expect(models.first.kind).toBe("llm");
});

it("reads the 바꾸기 drawer from the same lists and line revision as 작업 ↔ AI 모델, read-only", async () => {
  const { readFlowRankEditor } = await import("@/lib/operations/flow-rank-editor-read");
  const editor = await readFlowRankEditor();
  expect(editor).not.toBeNull();
  // 키 없이 목록도 못 읽은 연결 — 상태가 「응답 없음」으로 보인다(0 이나 정상으로 보이지 않는다)
  expect(editor!.states.find((row) => row.id === connectionId)).toMatchObject({ label, state: "no_list" });
  expect(editor!.lines.map((line) => line.key)).toEqual(expect.arrayContaining(["first-review#1", "second-review#3", "product-intro-check#1"]));
  for (const line of editor!.lines) expect(line.revision).toMatch(/^[a-f0-9]{64}$/);
  // 벨트 밖 작업(화면 판별)의 행은 서랍 줄에 섞이지 않는다
  expect(editor!.lines.some((line) => line.task === "screen-review")).toBe(false);
  expect(editor!.rows).toContainEqual(expect.objectContaining({ task: "screen-review", slot: 8, connectionId }));
});
