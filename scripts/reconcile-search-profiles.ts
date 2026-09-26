/** Dry-run: npx tsx scripts/reconcile-search-profiles.ts
 * Repair queue: add --apply --retry-invalid-output --retry-empty (existing worker regenerates; hashes are never rewritten here).
 */
import { reconcileSearchProfileBatch } from "../lib/domain/products/search-profiles";

async function main() {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (!["--apply", "--retry-invalid-output", "--retry-empty"].includes(arg)) throw new Error(`unknown option: ${arg}`);
  }
  const totals = { scanned: 0, mismatched: 0, alreadyPending: 0, queued: 0, verificationRetried: 0 };
  let afterId = 0;
  while (true) {
    const batch = await reconcileSearchProfileBatch({ afterId, apply: args.has("--apply"),
      retryInvalidOutput: args.has("--retry-invalid-output"), retryEmpty: args.has("--retry-empty") });
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += batch[key];
    if (batch.scanned === 0) break;
    afterId = batch.afterId;
  }
  console.log(JSON.stringify({ mode: args.has("--apply") ? "apply" : "dry-run", ...totals }));
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
