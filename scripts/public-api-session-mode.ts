/** Operator-only CLI. Run after explicit rollout approval; this task never invokes it against production. */
import { readRuntimeSettingsRow, saveRuntimeSettings } from "@/lib/operations/runtime-settings";

async function main() {
  const [mode, actor] = process.argv.slice(2);
  if ((mode !== "observe" && mode !== "enforce") || !actor) throw new Error("usage: public-api-session-mode.ts observe|enforce <actor>");
  const row = await readRuntimeSettingsRow();
  const result = await saveRuntimeSettings({ publicApi: { mode } }, actor, { group: "publicApi", expectedRevision: row.revision });
  if (!result.ok) throw new Error(result.issues.join(","));
  console.log(JSON.stringify({ mode, revision: result.revision }));
}
main().then(() => process.exit(0), () => { console.error("public_api_mode_save_failed"); process.exit(1); });
