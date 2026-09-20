import { readFileSync, writeFileSync } from "node:fs";
import { applyReconsideration, planReconsideration, type ReconsiderationPlan } from "@/lib/crawl/reconsider";

// Credentials are injected by the caller, never written into a plan or a receipt.
const args = process.argv.slice(2);
async function main() {
  if (args[0] === "--plan" && args[1]) {
    const plan = await planReconsideration();
    writeFileSync(args[1], JSON.stringify(plan, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ examined: plan.examined, eligible: plan.entries.length, plan: args[1] }));
  } else if (args[0] === "--apply" && args[1] && args[2]) {
    const plan: ReconsiderationPlan = JSON.parse(readFileSync(args[1], "utf8"));
    console.log(JSON.stringify(await applyReconsideration(plan, args[2])));
  } else throw new Error("Usage: --plan <new-plan.json> | --apply <plan.json> <actor>");
}
main().then(() => process.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : "reconsideration_failed"); process.exit(1); });
