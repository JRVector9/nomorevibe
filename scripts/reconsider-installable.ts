import { readFileSync, writeFileSync } from "node:fs";
import { applyReconsideration, planReconsideration, type ReconsiderationPlan } from "@/lib/crawl/reconsider";

// Credentials are injected by the caller, never written into a plan or a receipt.
const args = process.argv.slice(2);
async function main() {
  if (args[0] === "--plan" && args[1]) {
    // --policy package: 배포 URL 없음으로 거절된 5~499 스타 저장소를 패키지 증거 확인으로 다시 받는다
    const policy = args.includes("--policy") ? args[args.indexOf("--policy") + 1] : "installable";
    if (policy !== "installable" && policy !== "package") throw new Error("unknown_policy");
    const plan = await planReconsideration(2000, { includeAdmin: args.includes("--include-admin"), policy });
    writeFileSync(args[1], JSON.stringify(plan, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ examined: plan.examined, eligible: plan.entries.length, plan: args[1] }));
  } else if (args[0] === "--apply" && args[1] && args[2]) {
    const plan: ReconsiderationPlan = JSON.parse(readFileSync(args[1], "utf8"));
    console.log(JSON.stringify(await applyReconsideration(plan, args[2])));
  } else throw new Error("Usage: --plan <new-plan.json> [--include-admin] [--policy installable|package] | --apply <plan.json> <actor>");
}
main().then(() => process.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : "reconsideration_failed"); process.exit(1); });
