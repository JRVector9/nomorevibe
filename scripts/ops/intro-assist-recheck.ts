/** 명시적 소개 보강 요청. plan은 읽기만 하고 apply도 현재 raw 사진과 task 제어를 다시 검증한다. */
import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { introRecheckCandidateSchema } from "@/lib/domain/products/intro-assist";

export async function introAssistRecheckMain(args: readonly string[]) {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, strict: true,
    options: { ids: { type: "string" }, out: { type: "string" }, plan: { type: "string" }, actor: { type: "string" } } });
  if (positionals.length !== 1 || !["plan", "apply"].includes(positionals[0])) throw new Error("intro_recheck_invalid_command");
  if (positionals[0] === "plan" ? !values.ids || !values.out || values.plan || values.actor : !values.plan || !values.actor || values.ids || values.out)
    throw new Error("intro_recheck_invalid_options");
  const connectionString = process.env.INTRO_ASSIST_DATABASE_URL;
  if (!connectionString) throw new Error("intro_recheck_database_required");
  const [{ drizzle }, schema, { createDbClient, dbPoolConfig }, repository] = await Promise.all([import("drizzle-orm/postgres-js"),
    import("@/lib/db/schema"), import("@/lib/db/pool"), import("@/lib/domain/products/intro-assist-repository")]);
  const client = createDbClient(connectionString, { ...dbPoolConfig({ WORKER_ROLE: "reviewer", DB_POOL_MAX: "1" }),
    applicationName: "nomorevibe:intro-assist-plan" });
  const database = drizzle(client, { schema });
  try {
    if (positionals[0] === "plan") {
      if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(values.ids!)) throw new Error("intro_recheck_invalid_ids");
      const plans = await repository.planIntroRechecks(values.ids!.split(",").map(Number), database);
      await writeFile(values.out!, JSON.stringify({ version: 1, plans }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      process.stdout.write(JSON.stringify({ command: "plan", eligible: plans.length, wrotePlan: true }) + "\n");
    } else {
      const file = await open(values.plan!, "r"); let raw: unknown;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw new Error("intro_recheck_invalid_plan");
        raw = JSON.parse(await file.readFile("utf8"));
      } finally { await file.close(); }
      const plan = z.object({ version: z.literal(1), plans: z.array(z.object({ candidate: introRecheckCandidateSchema,
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(50) }).strict().parse(raw);
      const counts = { queued: 0, duplicate: 0, disabled: 0, stale: 0 };
      for (const item of plan.plans) counts[await repository.requestIntroRecheck(item, values.actor!, database)]++;
      process.stdout.write(JSON.stringify({ command: "apply", ...counts }) + "\n");
    }
  } finally { await client.end({ timeout: 5 }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void introAssistRecheckMain(process.argv.slice(2)).catch(() => {
    process.stderr.write(JSON.stringify({ code: "intro_recheck_refused" }) + "\n"); process.exitCode = 1;
  });
}
