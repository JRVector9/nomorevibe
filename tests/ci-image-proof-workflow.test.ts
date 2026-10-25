import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Kind = "worker" | "web";
type Step = { name?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
const root = path.resolve(__dirname, "..");
const workflow = parse(readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, { steps: Step[] }>;
};
const sha = "a".repeat(40), tree = "b".repeat(40), runId = 40148665183, runAttempt = 2;
const cases = (["worker", "web"] as const).flatMap((kind) =>
  (["promote", "build"] as const).map((source) => ({ kind, source })));

function proofStep(kind: Kind) {
  const step = workflow.jobs[`publish-${kind}-image`].steps.find((item) => item.env?.IMAGE_DIGEST);
  expect(step?.run).toBe("node scripts/ci-image-receipt.mjs");
  return step!;
}

function interpolate(value: string, directory: string, digest: string, profile = "full") {
  const expressions: Record<string, string> = {
    "github.sha": sha,
    "needs.scope.outputs.tree": tree,
    "steps.promote.outputs.digest || steps.build.outputs.digest": digest,
    "needs.scope.outputs.test_profile": profile,
    "needs.scope.outputs.rules_version": "v2",
    "runner.temp": directory,
  };
  return value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression: string) => {
    expect(expressions, `unsupported workflow expression: ${expression}`).toHaveProperty(expression);
    return expressions[expression];
  });
}

function writer(step: Step, directory: string, digest: string, profile = "full") {
  const env = Object.fromEntries(Object.entries(step.env!).map(([key, value]) =>
    [key, interpolate(value, directory, digest, profile)]));
  const [, ...args] = step.run!.trim().split(/\s+/);
  const result = spawnSync(process.execPath, args, {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, NODE_ENV: "test", ...env, GITHUB_RUN_ID: String(runId), GITHUB_RUN_ATTEMPT: String(runAttempt) },
  });
  return { result, env };
}

const parseInPython = `
import importlib.util, io, json, pathlib, sys, zipfile
spec = importlib.util.spec_from_file_location('proof_readiness', sys.argv[1])
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)
receipt = pathlib.Path(sys.argv[2])
archive = io.BytesIO()
with zipfile.ZipFile(archive, 'w') as zipped:
    zipped.writestr(receipt.name, receipt.read_bytes())
print(json.dumps(readiness.parse_image_artifact(archive.getvalue(), kind=sys.argv[3],
    sha=sys.argv[4], tree=sys.argv[5], run_id=int(sys.argv[6]), run_attempt=int(sys.argv[7]))))
`;

describe("published image proof workflow integration", () => {
  it.each(cases)("$kind $source output becomes the exact Node receipt and Python readiness artifact", ({ kind, source }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "nmv-image-proof-"));
    try {
      const digest = `sha256:${(source === "promote" ? "c" : "d").repeat(64)}`;
      const profile = source === "promote" ? "full" : "ui";
      const { result, env } = writer(proofStep(kind), directory, digest, profile);
      expect(result.status, result.stderr).toBe(0);
      const output = path.join(directory, `release-image-${kind}.json`);
      expect(env.RECEIPT_FILE).toBe(output);
      const repository = kind === "worker" ? "nomorevibe-worker" : "nomorevibe-runtime-web";
      const expected = { schemaVersion: 1, release: sha, tree, kind,
        image: `ghcr.io/jrvector9/${repository}@${digest}`, runId, runAttempt,
        testProfile: profile, rulesVersion: "v2" };
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(expected);
      const upload = workflow.jobs[`publish-${kind}-image`].steps.find((step) =>
        step.with?.name?.startsWith("release-image-"));
      expect(interpolate(upload!.with!.path, directory, digest, profile)).toBe(output);
      expect(interpolate(upload!.with!.name, directory, digest, profile)).toBe(`release-image-${kind}-${sha}`);
      const python = spawnSync("python3", ["-I", "-B", "-c", parseInPython,
        path.join(root, "scripts/ops/release_readiness.py"), output, kind, sha, tree, String(runId), String(runAttempt)], {
        encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, NODE_ENV: "test" },
      });
      expect(python.status, python.stderr).toBe(0);
      expect(JSON.parse(python.stdout)).toEqual(expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["worker", "web"] as const)("rejects the broken IMAGE_%s workflow environment without creating an artifact", (kind) => {
    const directory = mkdtempSync(path.join(tmpdir(), "nmv-image-proof-broken-"));
    try {
      const step = proofStep(kind);
      const brokenEnv = { ...step.env, [`IMAGE_${kind}`]: kind };
      delete brokenEnv.IMAGE_KIND;
      const { result, env } = writer({ ...step, env: brokenEnv }, directory, `sha256:${"c".repeat(64)}`);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("image_receipt_invalid");
      expect(existsSync(env.RECEIPT_FILE)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
