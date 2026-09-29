import { readFileSync, writeFileSync } from "node:fs";
import { applyReconsideration, planReconsideration, type ReconsiderationPlan } from "@/lib/crawl/reconsider";

const args = process.argv.slice(2);

async function main() {
  if (args[0] === "--plan" && args[1] && !args[2]) {
    const plan = await planReconsideration(2000, { policy: "star-auto" });
    writeFileSync(args[1], JSON.stringify(plan, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ examined: plan.examined, eligible: plan.entries.length, path: args[1] }));
  } else if (args[0] === "--apply" && args[1] && args[2] && !args[3]) {
    const plan: ReconsiderationPlan = JSON.parse(readFileSync(args[1], "utf8"));
    if (plan.policy !== "star-auto") throw new Error("wrong_reconsideration_policy");
    const result = await applyReconsideration(plan, args[2]);
    console.log(JSON.stringify({ queued: result.queued.length, changed: result.changed.length,
      queuedRepos: result.queued, changedRepos: result.changed }));
  } else throw new Error("Usage: --plan <new-plan.json> | --apply <plan.json> <actor>");
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error instanceof Error ? error.message : "star_auto_reconsideration_failed");
  process.exit(1);
});
