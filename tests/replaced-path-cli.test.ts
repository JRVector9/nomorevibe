import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { replacedPathDigest as sha, replacedPathReceiptSchema } from "@/lib/llm/replaced-path-boundary-contract";
import { hopProgram, replacedPathMain } from "@/scripts/ops/replaced-path/release-cli";
import { replacedPathFixture } from "./fixtures/replaced-path-boundary";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "replaced-path-cli-")); dirs.push(dir);
  const { plan, receipt } = replacedPathFixture();
  const bundle = receipt.hops.map(hop => { const artifact = JSON.stringify({ hop: hop.service }); return { hop: { ...hop, artifactHash: sha(artifact) }, artifact }; });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan), { mode: 0o600 });
  return { dir, plan, bundle };
}
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

it("assembles the registered hop order from split bundles and stores each artifact by its hash", async () => {
  const { dir, bundle } = setup();
  write(join(dir, "a.json"), bundle.slice(3)); write(join(dir, "b.json"), bundle.slice(0, 3).reverse());
  const result = await replacedPathMain(["receipt", `--plan=${join(dir, "plan.json")}`, `--bundle=${join(dir, "a.json")},${join(dir, "b.json")}`,
    `--artifact-dir=${join(dir, "artifacts")}`, `--out=${join(dir, "receipt.json")}`]) as { receiptSha: string };
  const raw = readFileSync(join(dir, "receipt.json"));
  expect(sha(raw)).toBe(result.receiptSha);
  const receipt = replacedPathReceiptSchema.parse(JSON.parse(raw.toString()));
  expect(receipt.hops.map(h => h.role)).toEqual(["owner", "gateway-m3", "gateway-mini", "relay", "provider"]);
  for (const entry of bundle) expect(readFileSync(join(dir, "artifacts", `${entry.hop.artifactHash}.json`), "utf8")).toBe(entry.artifact);
});
it("refuses a tampered artifact, a missing hop and a world-readable input", async () => {
  const { dir, bundle } = setup(), args = (b: string) => ["receipt", `--plan=${join(dir, "plan.json")}`, `--bundle=${b}`,
    `--artifact-dir=${join(dir, "artifacts")}`, `--out=${join(dir, `${Math.random()}.json`)}`];
  write(join(dir, "tampered.json"), [{ ...bundle[0], artifact: "{}" }, ...bundle.slice(1)]);
  await expect(replacedPathMain(args(join(dir, "tampered.json")))).rejects.toThrow("replaced_path_bundle_conflict");
  write(join(dir, "missing.json"), bundle.slice(1));
  await expect(replacedPathMain(args(join(dir, "missing.json")))).rejects.toThrow("replaced_path_hop_missing");
  writeFileSync(join(dir, "open.json"), JSON.stringify(bundle), { mode: 0o644 });
  await expect(replacedPathMain(args(join(dir, "open.json")))).rejects.toThrow("replaced_path_private_file_required");
});
it("binds the reviewed helper and only the hop request into the remote program", () => {
  const program = hopProgram({ role: "provider", host: "supa", kind: "systemd", service: "vllm.service" });
  expect(program.startsWith('import io,sys\nsys.stdin=io.StringIO("{\\"role\\":\\"provider\\"')).toBe(true);
  expect(program).toContain(readFileSync("scripts/ops/replaced-path/collect_hop.py", "utf8"));
});
