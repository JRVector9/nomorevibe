import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { MODEL_CAPACITY_INDETERMINATE_REASONS, modelCapacityIndeterminateReason, operatorReviewEvidenceHash, operatorReviewEvidenceSchema } from "@/lib/llm/capacity";
import { MODEL_CAPACITY_LIVE_STATES, MODEL_CAPACITY_LIVE_STATES_SQL, MODEL_CAPACITY_OCCUPYING_STATES, MODEL_CAPACITY_OCCUPYING_STATES_SQL,
  inFlightStateSql, liveStateSql, occupyingStateSql, reviewStateSql, sentStateSql, unsettledDispatchStateSql } from "@/lib/llm/capacity-states";
import { modelCapacityRequests } from "@/lib/db/operations-schema";

const render = (value: ReturnType<typeof liveStateSql>) => new PgDialect().sqlToQuery(value).sql;

it("keeps indeterminate out of every live/occupying list and renders the same text for raw and column inputs (2026-10-30 owner decision)", () => {
  expect(MODEL_CAPACITY_LIVE_STATES).toEqual(["waiting", "reserved", "dispatched"]);
  expect(MODEL_CAPACITY_OCCUPYING_STATES).toEqual(["reserved", "dispatched"]);
  expect(MODEL_CAPACITY_LIVE_STATES_SQL).toBe("('waiting','reserved','dispatched')");
  expect(MODEL_CAPACITY_OCCUPYING_STATES_SQL).toBe("('reserved','dispatched')");
  expect(render(liveStateSql())).toBe("state IN ('waiting','reserved','dispatched')");
  expect(render(liveStateSql("r.state"))).toBe("r.state IN ('waiting','reserved','dispatched')");
  expect(render(occupyingStateSql(modelCapacityRequests.state))).toBe("\"model_capacity_requests\".\"state\" IN ('reserved','dispatched')");
  expect(render(inFlightStateSql(sql`c.state`))).toBe("c.state = 'dispatched'");
  expect(render(unsettledDispatchStateSql())).toBe("state IN ('dispatched','indeterminate')");
  expect(render(sentStateSql())).toBe("state IN ('dispatched','indeterminate','settled')");
  expect(render(reviewStateSql("r.state"))).toBe("r.state = 'indeterminate'");
  for (const fragment of [liveStateSql(), occupyingStateSql(), inFlightStateSql()]) expect(render(fragment)).not.toContain("indeterminate");
});

it("names the client deadline distinctly from an abort and from an unknown transport outcome", () => {
  expect(MODEL_CAPACITY_INDETERMINATE_REASONS).toContain("client_timeout");
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const abort = new DOMException("The operation was aborted", "AbortError");
  expect(modelCapacityIndeterminateReason({ timedOut: true })).toBe("client_timeout");
  expect(modelCapacityIndeterminateReason({ error: timeout })).toBe("client_timeout");
  expect(modelCapacityIndeterminateReason({ signal: AbortSignal.abort(timeout), error: abort })).toBe("client_timeout");
  expect(modelCapacityIndeterminateReason({ signal: AbortSignal.abort(), error: abort })).toBe("local_abort");
  expect(modelCapacityIndeterminateReason({ signal: AbortSignal.abort("shutdown") })).toBe("local_abort");
  expect(modelCapacityIndeterminateReason({ signal: new AbortController().signal, error: new TypeError("fetch failed") })).toBe("transport_unknown");
  expect(modelCapacityIndeterminateReason({})).toBe("transport_unknown");
  expect(modelCapacityIndeterminateReason({ signal: null, timedOut: false })).toBe("transport_unknown");
});

it("hashes operator review evidence canonically and rejects a blank note", () => {
  const base = { version: 1 as const, kind: "operator_review" as const, requestId: "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b",
    owner: { instanceId: "m3-reviewer", bootId: "1b2c3d4e-5f60-4718-9a0b-1c2d3e4f5a6b" }, fromState: "indeterminate" as const,
    operator: "jr", note: "엔진 재시작 확인", reviewedAt: "2026-10-30T12:00:00.000Z" };
  expect(operatorReviewEvidenceHash(base)).toBe(operatorReviewEvidenceHash({ ...base, owner: { bootId: base.owner.bootId, instanceId: base.owner.instanceId } }));
  expect(operatorReviewEvidenceSchema.safeParse({ ...base, note: "   " }).success).toBe(false);
  expect(operatorReviewEvidenceSchema.safeParse({ ...base, fromState: "dispatched" }).success).toBe(false);
  expect(operatorReviewEvidenceSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
});
