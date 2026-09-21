import { reconcileCrawlDuplicates } from "@/lib/crawl/duplicate-reconciliation";

const args = process.argv.slice(2);
async function main() {
  if (!["--preview", "--apply"].includes(args[0]) || !args[1] || args.length !== 2) {
    throw new Error("Usage: --preview <actor> | --apply <actor>");
  }
  console.log(JSON.stringify(await reconcileCrawlDuplicates({ actor: args[1], apply: args[0] === "--apply" })));
}
main().then(() => process.exit(0)).catch(error => {
  console.error(error instanceof Error ? error.message : "duplicate_reconciliation_failed");
  process.exit(1);
});
