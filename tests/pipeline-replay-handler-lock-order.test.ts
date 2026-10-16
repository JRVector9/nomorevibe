import { expect, it } from "vitest";
import type postgres from "postgres";
import type { ReplayDatabaseIdentity } from "@/lib/operations/pipeline-replay-database";
import { provisionHandlerProfile } from "@/lib/operations/pipeline-replay-handler-profile";

// Fixed policy targets, independent of the provisioner's policy construction.
const expectedTargets = [
  '"pipeline_replay"."capacity_calls"',
  '"public"."agent_repository_observations"',
  '"public"."agent_repository_scans"',
  '"public"."crawl_candidates"',
  '"public"."crawl_documents"',
  '"public"."crawl_frontier"',
  '"public"."crawl_review_attempts"',
  '"public"."crawl_settings"',
  '"public"."jobs"',
  '"public"."operations_observations"',
  '"public"."pipeline_item_leases"',
  '"public"."pipeline_stage_modes"',
  '"public"."products"',
  '"public"."second_reviews"',
];
const identity: ReplayDatabaseIdentity = {
  version: 1, databaseUrl: "postgres://fixture@127.0.0.1/nomorevibe_test",
  databaseName: "nomorevibe_test", databaseOid: 101, schemaName: "pipeline_replay", schemaOid: 102,
  roleName: "nomorevibe_replay_0123456789abcdef", roleOid: 103, ownerOid: 104, nonce: "a".repeat(64),
};
const isTargetAclMutation = (statement: string) =>
  /^GRANT .+ ON (?:public\.|pipeline_replay\."?capacity_calls"?\b)/.test(statement);

it.each(["handlers-v5", "handlers-v6-item"] as const)(
  "%s locks every trigger target before its first target ACL mutation",
  async version => {
    const statements: string[] = [], sentinel = new Error("first_target_acl_reached");
    const record = async (statement: string) => {
      statements.push(statement.replace(/\s+/g, " ").trim());
      if (isTargetAclMutation(statements.at(-1)!)) throw sentinel;
      return statement.includes("to_regclass") ? [{ present: false }] : [];
    };
    // Execute only the real provisioner's prefix. No PostgreSQL client or full-profile simulator.
    const tx = Object.assign((strings: TemplateStringsArray) => record(strings.join("?")), {
      unsafe: (statement: string) => record(statement),
    }) as unknown as postgres.TransactionSql;
    await expect(provisionHandlerProfile(tx, identity, version)).rejects.toBe(sentinel);
    const aclIndex = statements.findIndex(isTargetAclMutation);
    expect(aclIndex).toBeGreaterThan(0);
    expect(aclIndex).toBe(statements.length - 1);
    const locks = statements.slice(0, aclIndex).filter(statement => statement.startsWith("LOCK TABLE "));
    expect(locks.length).toBeGreaterThan(0);
    const targets = locks.flatMap(statement => {
      const match = /^LOCK TABLE (.+) IN SHARE ROW EXCLUSIVE MODE$/.exec(statement);
      expect(match).not.toBeNull();
      return match![1].split(/,\s*/);
    });
    expect(targets).toHaveLength(14);
    expect(new Set(targets).size).toBe(14);
    expect(targets).toEqual(expectedTargets);
  },
);
