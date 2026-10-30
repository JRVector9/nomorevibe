/**
 * Replaced-path release, run by the operator on gpu3090. Steps: plan (READ ONLY, needs DRAIN) → collect (read-only SSH) → receipt → release.
 * The DB trigger re-checks everything; these steps only assemble reviewed bytes. No stop, restart or model call happens here.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseDatabaseUrl } from "../dr/promotion";
import { REPLACED_PATH_PROBES, replacedPathHopSchema, replacedPathPlanHash, replacedPathPlanSchema, replacedPathReceiptSchema, replacedPathRequiredHops,
  validReplacedPathHops, replacedPathArtifactHashes, type ReplacedPathHop, type ReplacedPathPlan } from "@/lib/llm/replaced-path-boundary-contract";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
/** Registry host → this operator shell's SSH alias. m1studio is reached only through device_admin. */
// m1studio: the operator host ssh alias (user-level, read-only probes; the relay launchd probe reads as absent without root).
export const REPLACED_PATH_SSH: Readonly<Record<string, string>> = { m3ultra: "m3ultra", "9mini": "9mini", supa: "supa", m1studio: "m1-studio" };
const HOP_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "collect_hop.py");

function privateFile(path: string, cap = 5 * 1024 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > cap) throw new Error("replaced_path_private_file_required");
  return readFileSync(path);
}
function writePrivate(path: string, raw: string) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
  return sha(raw);
}
function options(args: readonly string[], allowed: readonly string[], flags: readonly string[] = []) {
  const opts = new Map<string, string>(), set = new Set<string>();
  for (const arg of args) {
    if (flags.includes(arg) && !set.has(arg)) { set.add(arg); continue; }
    const m = /^--([a-z-]+)=([^\n]+)$/.exec(arg);
    if (!m || !allowed.includes(m[1]) || opts.has(m[1])) throw new Error("replaced_path_cli_option");
    opts.set(m[1], m[2]);
  }
  return { get: (key: string) => { const value = opts.get(key); if (value === undefined) throw new Error("replaced_path_cli_required"); return value; },
    has: (key: string) => opts.has(key), flag: (name: string) => set.has(name) };
}
const readPlan = (path: string) => replacedPathPlanSchema.parse(JSON.parse(privateFile(path).toString("utf8")));
/** Program text for `python3 -I -`: the reviewed helper with its request (and registered probe options) bound in, so stdin carries only reviewed code. */
export function hopProgram(hop: { role: string; host: string; kind: string; service: string }) {
  const probe = REPLACED_PATH_PROBES[`${hop.host}\n${hop.service}`] ?? {}, request = { role: hop.role, host: hop.host, kind: hop.kind, service: hop.service, ...probe };
  return `import io,sys\nsys.stdin=io.StringIO(${JSON.stringify(JSON.stringify(request))})\n${readFileSync(HOP_SOURCE, "utf8")}`;
}
/** The same program as one newline-free argument for device_admin (≤ 8,000 chars per argument). zlib/base64 only change transport. */
export function compactHopProgram(hop: { role: string; host: string; kind: string; service: string }) {
  const packed = deflateSync(Buffer.from(hopProgram(hop), "utf8"), { level: 9 }).toString("base64");
  return `import base64,zlib;exec(compile(zlib.decompress(base64.b64decode('${packed}')),'collect_hop','exec'))`;
}
export const deviceAdminHopArgv = (hop: { role: string; host: string; kind: string; service: string }) =>
  ({ executable: "/usr/bin/perl", args: ["-e", "alarm 55; exec @ARGV; die $!", "/usr/bin/python3", "-I", "-c", compactHopProgram(hop)] });
const bundleHopSchema = replacedPathHopSchema.omit({ mode: true }).extend({ idle: z.boolean().nullable() }).strict();
const bundleSchema = z.array(z.object({ hop: bundleHopSchema, artifact: z.string().min(2).max(1024 * 1024) }).strict()).min(1).max(8);
type BundleHop = z.infer<typeof bundleHopSchema>;
/** Prefer the strongest fact: a replacement, else an observed absence, else (engine only) an idle readback. Validation still decides. */
export function hopMode(plan: ReplacedPathPlan, hop: BundleHop): ReplacedPathHop {
  const { idle, ...rest } = hop;
  const mode = hop.startedAt === null ? "absent" : Date.parse(hop.startedAt) > Date.parse(plan.request.dispatchAt) ? "replaced" : idle === true ? "idle" : "replaced";
  return { ...rest, mode };
}

async function withDatabase<T>(load: () => Promise<T>) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 4096) throw new Error("dr_cli_invalid_database_url"); }
  if ((globalThis as { db?: unknown; pgClient?: unknown }).db || (globalThis as { pgClient?: unknown }).pgClient) throw new Error("dr_cli_database_already_open");
  process.env.DATABASE_URL = parseDatabaseUrl(Buffer.concat(chunks).toString("utf8")); delete process.env.READ_DATABASE_URL;
  try { return await load(); }
  finally { await (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }).catch(() => {}); }
}

export async function replacedPathMain(args: readonly string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (command === "plan") {
    const o = options(rest, ["request-id", "reference", "out"], ["--database-url-stdin"]);
    if (!o.flag("--database-url-stdin")) throw new Error("replaced_path_cli_required");
    const plan = await withDatabase(async () => (await import("@/lib/operations/dr/replaced-path-boundary-release"))
      .readReplacedPathPlan({ requestId: z.uuid().parse(o.get("request-id")), reviewReference: o.get("reference") }));
    const planSha = writePrivate(o.get("out"), JSON.stringify(plan));
    return { planSha, planHash: replacedPathPlanHash(plan), hops: replacedPathRequiredHops(plan.request.owner.instanceId, plan.request.providerBudgetId) };
  }
  if (command === "collect" || command === "probe") {
    // probe: the same read-only readback without a plan or files, to rehearse the path before any DRAIN.
    const o = command === "probe" ? options(rest, ["owner", "budget", "skip-host"]) : options(rest, ["plan", "out", "skip-host"]);
    const plan = command === "collect" ? readPlan(o.get("plan")) : null, skip = new Set(o.has("skip-host") ? o.get("skip-host").split(",") : []);
    const required = plan ? replacedPathRequiredHops(plan.request.owner.instanceId, plan.request.providerBudgetId) : replacedPathRequiredHops(o.get("owner"), o.get("budget"));
    if (!required) throw new Error("replaced_path_topology_unregistered");
    const bundle: { hop: unknown; artifact: string }[] = [], manual: unknown[] = [];
    for (const request of required) {
      const program = hopProgram(request);
      if (skip.has(request.host) || !Object.hasOwn(REPLACED_PATH_SSH, request.host)) {
        // device_admin argv: the same reviewed helper, read-only, root on the target host.
        manual.push({ hop: request, argv: deviceAdminHopArgv(request) });
        continue;
      }
      const out = execFileSync("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", REPLACED_PATH_SSH[request.host], "/usr/bin/python3 -I -"],
        { input: program, timeout: 90_000, maxBuffer: 2 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8");
      const value = JSON.parse(out);
      if (value.error) throw new Error(`replaced_path_hop_${String(value.error).replace(/[^a-z0-9_]/gi, "_").slice(0, 60)}`);
      bundle.push(value);
    }
    if (!plan) return { hops: bundle.map(entry => entry.hop), manual: manual.map(entry => (entry as { hop: unknown }).hop) };
    const bundleSha = writePrivate(o.get("out"), JSON.stringify(bundleSchema.parse(bundle)));
    return { bundleSha, collected: bundle.length, manual };
  }
  if (command === "receipt") {
    const o = options(rest, ["plan", "bundle", "artifact-dir", "out"]);
    const plan = readPlan(o.get("plan")), dir = o.get("artifact-dir");
    const entries = o.get("bundle").split(",").flatMap(path => bundleSchema.parse(JSON.parse(privateFile(path).toString("utf8"))));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const byRole = new Map<string, BundleHop>();
    for (const { hop, artifact } of entries) {
      if (sha(artifact) !== hop.artifactHash || byRole.has(`${hop.role}\n${hop.service}`)) throw new Error("replaced_path_bundle_conflict");
      byRole.set(`${hop.role}\n${hop.service}`, hop);
      const file = resolve(dir, `${hop.artifactHash}.json`);
      try { if (sha(privateFile(file)) !== hop.artifactHash) throw new Error("replaced_path_artifact_conflict"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; writePrivate(file, artifact); }
    }
    const required = replacedPathRequiredHops(plan.request.owner.instanceId, plan.request.providerBudgetId) ?? [];
    const found = required.map(r => byRole.get(`${r.role}\n${r.service}`));
    if (found.some(hop => !hop)) throw new Error("replaced_path_hop_missing");
    const hops = found.map(hop => hopMode(plan, hop!)), observedAt = hops.map(hop => hop.observedAt).sort().at(-1)!;
    const receipt = replacedPathReceiptSchema.parse({ version: 1, kind: "replaced_path_boundary_receipt", planHash: replacedPathPlanHash(plan), observedAt, hops });
    if (!validReplacedPathHops(plan, receipt)) throw new Error("replaced_path_hops_not_replaced_after_dispatch");
    return { receiptSha: writePrivate(o.get("out"), JSON.stringify(receipt)), observedAt };
  }
  if (command === "release") {
    const o = options(rest, ["plan", "plan-sha", "receipt", "receipt-sha", "artifact-dir", "operator", "reference"], ["--database-url-stdin", "--apply"]);
    if (!o.flag("--database-url-stdin")) throw new Error("replaced_path_cli_required");
    const planBytes = privateFile(o.get("plan")), receiptBytes = privateFile(o.get("receipt"));
    if (sha(planBytes) !== o.get("plan-sha")) throw new Error("replaced_path_plan_file_hash");
    if (sha(receiptBytes) !== o.get("receipt-sha")) throw new Error("replaced_path_receipt_file_hash");
    const plan = replacedPathPlanSchema.parse(JSON.parse(planBytes.toString("utf8")));
    const receipt = replacedPathReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
    for (const hash of replacedPathArtifactHashes(receipt))
      if (sha(privateFile(resolve(o.get("artifact-dir"), `${hash}.json`))) !== hash) throw new Error("replaced_path_artifact_hash");
    const apply = o.flag("--apply");
    const result = await withDatabase(async () => (await import("@/lib/operations/dr/replaced-path-boundary-release"))
      .releaseReplacedPathBoundaryRequest({ plan, receipt, expectedPlanHash: replacedPathPlanHash(plan), operator: o.get("operator"), reference: o.get("reference") }, apply));
    return { dryRun: !apply, result };
  }
  throw new Error("replaced_path_cli_command");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void replacedPathMain(process.argv.slice(2))
  .then(value => { process.stdout.write(`${JSON.stringify(value)}\n`); })
  .catch(error => {
    const code = error instanceof Error && /^(replaced_path|dr)_[a-z0-9_]+$/.test(error.message) ? error.message : "replaced_path_release_failed";
    // Zod paths describe missing evidence without echoing input, DB URLs or secrets.
    const missing = error && typeof error === "object" && "issues" in error ? (error.issues as { path: unknown[] }[]).map(issue => issue.path.join(".")) : [];
    process.stderr.write(`${JSON.stringify({ code, missing })}\n`); process.exitCode = 1;
  });
