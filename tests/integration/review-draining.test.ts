import { beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { requestJob } from "@/lib/jobs/control";
import { getJobState, runJob } from "@/lib/jobs/runner";
import { ensureSchema } from "./setup";
beforeAll(ensureSchema);
beforeEach(async () => { await db.delete(jobs); });
it.each([false, true])("leaves one ready request, preserving an arriving request=%s", async arrived => {
  await requestJob("crawl-agent-review");
  await runJob("crawl-agent-review", async () => {
    if (arrived) await requestJob("crawl-agent-review");
    return { done: false, continuation: "ready" as const };
  }, { requestedOnly: true });
  expect(await getJobState("crawl-agent-review")).toMatchObject({ processedVersion: 1, requestedVersion: 2 });
});
it("ordinary done:false does not self-request and unapproved jobs cannot opt in", async () => {
  for (const [name, continuation] of [["crawl-agent-review", undefined], ["crawl-fetch", "ready"]] as const) {
    await requestJob(name);
    await runJob(name, async () => ({ done: false, continuation }), { requestedOnly: true });
    expect(await getJobState(name)).toMatchObject({ processedVersion: 1, requestedVersion: 1 });
  }
});
