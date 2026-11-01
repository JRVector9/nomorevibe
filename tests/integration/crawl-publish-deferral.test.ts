import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { publishCandidates } from "@/lib/crawl/jobs/publish";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { requestJob } from "@/lib/jobs/control";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// Keep the real publisher handler, runner, producer and PostgreSQL transactions.
// Only candidate preparation and the external classification boundary are fixtures.
const boundary = vi.hoisted(() => ({
  candidates: vi.fn(), prepare: vi.fn(), authority: vi.fn(), path: vi.fn(),
  agent: vi.fn(), classify: vi.fn(), publish: vi.fn(), hold: vi.fn(),
}));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({ enabled: true, classify: { definitions: {} } }) }));
vi.mock("@/lib/crawl/repository", () => ({ listCandidates: boundary.candidates }));
vi.mock("@/lib/crawl/publish", () => ({ prepareCandidateClassification: boundary.prepare, publishCandidate: boundary.publish }));
vi.mock("@/lib/crawl/publication-classify-capacity", () => ({ publicationClassificationAuthority: boundary.authority, publicationClassificationPath: boundary.path }));
vi.mock("@/lib/operations/agent-client", () => ({ agentRequest: boundary.agent }));
vi.mock("@/lib/crawl/classify", () => ({ classifyCategories: boundary.classify }));
vi.mock("@/lib/operations/categories", () => ({
  classificationReadyPredicate: () => undefined, decisionFor: async () => null, holdClassification: boundary.hold,
}));
vi.mock("@/lib/crawl/agent-review-repository", () => ({
  requeueInvalidStarApprovals: async () => 0, reviewApprovalPredicate: () => undefined, starAutoApprovalPredicate: () => undefined,
}));

const admin = postgres(TEST_DATABASE_URL, { max: 2 });
const name = "crawl-publish";
const observationKey = `job:${name}`;
let originalJob: Record<string, unknown> | undefined;
let originalObservation: Record<string, unknown> | undefined;

async function jobRow() {
  const [row] = await admin`select to_jsonb(j) as value from jobs j where name=${name}`;
  return row?.value as Record<string, unknown> | undefined;
}
async function observationRow() {
  const [row] = await admin`select to_jsonb(o) as value from operations_observations o where key=${observationKey}`;
  return row?.value as Record<string, unknown> | undefined;
}
beforeAll(async () => {
  ensureSchema();
  originalJob = await jobRow();
  originalObservation = await observationRow();
});
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv("CONNECT_AGENT_URL", "http://agent.test");
  boundary.candidates.mockResolvedValue([{ id: 42, repo: "owner/tool" }]);
  boundary.prepare.mockResolvedValue({ input: { repo: "owner/tool" }, snapshot: { document: {}, starAutoApproved: false } });
  await admin`insert into jobs(name,requested_version,processed_version,cursor,last_success_at,last_error,runs,next_scheduled_at)
    values(${name},12,7,'{"page":4}',timestamp '2026-10-01 01:02:03.123456','previous failure',4,timestamp '2026-10-20 01:02:03.654321')
    on conflict(name) do update set requested_version=12,processed_version=7,cursor=excluded.cursor,
      last_success_at=excluded.last_success_at,last_error=excluded.last_error,runs=4,next_scheduled_at=excluded.next_scheduled_at,
      locked_at=null,lease_token=null,not_before=null`;
  await admin`insert into operations_observations(key,value,observed_at)
    values(${observationKey},'{"degraded":{"code":"previous_failure","streak":3}}',timestamp '2026-10-01 01:02:03.654321')
    on conflict(key) do update set value=excluded.value,observed_at=excluded.observed_at`;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  try {
    await admin.begin(async tx => {
      if (originalJob) {
        const columns = Object.keys(originalJob).filter(key => key !== "name");
        await tx.unsafe(`update jobs set (${columns.join(",")})=(select ${columns.join(",")} from jsonb_populate_record(null::jobs,$1::text::jsonb)) where name=$2`, [JSON.stringify(originalJob), name]);
      } else await tx`delete from jobs where name=${name}`;
      if (originalObservation) {
        await tx`update operations_observations set value=${tx.json(originalObservation.value as postgres.JSONValue)},
          observed_at=${String(originalObservation.observed_at)}::text::timestamp where key=${observationKey}`;
      } else await tx`delete from operations_observations where key=${observationKey}`;
    });
    expect(await jobRow()).toEqual(originalJob);
    expect(await observationRow()).toEqual(originalObservation);
  } finally { await admin.end(); }
});

it.each(["admission refused", "native RPC response lost", "native agent unavailable"] as const)(
  "%s preserves pending publication signals and history through the real runner",
  async scenario => {
    let before: Record<string, unknown> | undefined;
    const observationBefore = await observationRow();
    const producerAndPause = async () => {
      // A producer and an administrator can change the job while its handler waits.
      await requestJob(name);
      await admin`update jobs set not_before=timestamp '2100-01-01 01:02:03.123456' where name=${name}`;
      before = await jobRow();
    };
    if (scenario === "admission refused") {
      boundary.authority.mockImplementation(async () => {
        await producerAndPause();
        throw new ModelCapacityDeferredError("capacity");
      });
    } else if (scenario === "native RPC response lost") {
      boundary.authority.mockResolvedValue({ requestId: "native-request" });
      boundary.agent.mockImplementation(async () => {
        await producerAndPause();
        throw new Error("RPC response lost");
      });
    } else {
      vi.stubEnv("CONNECT_AGENT_URL", "");
      boundary.path.mockImplementation(async () => { await producerAndPause(); return "native"; });
    }

    const onDeferred = vi.fn();
    const result = await runJob(name, publishCandidates, { requestedOnly: true, onDeferred });
    expect(result).toMatchObject({ status: "deferred", reason: "model_capacity" });
    expect(before).toMatchObject({ requested_version: 13, processed_version: 7, cursor: { page: 4 },
      last_success_at: "2026-10-01T01:02:03.123456", last_error: "previous failure",
      next_scheduled_at: "2026-10-20T01:02:03.654321", not_before: "2100-01-01T01:02:03.123456" });
    // 던지지 않고 끝난 미룸 틱은 지난 실패 기록(last_error)만 지운다(runner.ts) — 요청·커서·멈춤·성공 시각은 그대로
    expect(await jobRow()).toEqual({ ...before, locked_at: null, lease_token: null, last_error: null });
    expect(await observationRow()).toEqual(observationBefore);
    expect(onDeferred).toHaveBeenCalledExactlyOnceWith("model_capacity");
    expect(boundary.agent).toHaveBeenCalledTimes(scenario === "native RPC response lost" ? 1 : 0);
    expect(boundary.classify).not.toHaveBeenCalled();
    expect(boundary.publish).not.toHaveBeenCalled();
    expect(boundary.hold).not.toHaveBeenCalled();
  },
);
