import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parseLayaEvaluationInput } from "../lib/crawl/laya-evaluation";
import { LAYA_QUESTION_VERSION } from "../lib/crawl/laya-preview";

const run = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/prepare-laya-quality-audit.ts", ...args], {
    env: { ...process.env, LAYA_URL: "", LAYA_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  child.on("error", reject); child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
});
async function fixture(work: (directory: string, args: string[]) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "nmv-quality-test-"));
  try {
    const samples = parseLayaEvaluationInput({ version: 1, samples: Array.from({ length: 6 }, (_, i) => ({ id: String(i),
      snapshot: { product: { repo: `sample/tool-${i}`, name: "Tool", accessMode: "installable", description: "SOURCE_MARKER",
        readme: "Readme", pageText: "" }, repoFacts: { stars: 800 } }, first: { decision: "approve" },
    })) });
    const response = { version: 1, mode: "live", complete: true, questionVersion: LAYA_QUESTION_VERSION,
      rows: samples.map((sample, i) => ({ id: sample.id,
        subjectHash: createHash("sha256").update(JSON.stringify({ ...sample.snapshot.product, stars: 800 })).digest("hex"),
        hint: { authority: "none", kind: "hint", questionVersion: LAYA_QUESTION_VERSION, softwareProbability: i / 6,
          durationMs: 20, requestHash: "a".repeat(64), routingModel: "english", truncated: false },
      })),
    };
    const input = path.join(directory, "input.json"), responses = path.join(directory, "responses.json");
    await writeFile(input, JSON.stringify({ version: 1, samples })); await writeFile(responses, JSON.stringify(response));
    await work(directory, ["--input", input, "--responses", responses, "--out-dir", path.join(directory, "out"), "--seed", "fixture", "--take", "2"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

it("CLI creates a blind offline board and pending summary without credentials", () => fixture(async (dir, args) => {
  const result = await run(args); expect(result.code).toBe(0); expect(result.output).not.toContain("SOURCE_MARKER");
  expect(JSON.parse(await readFile(path.join(dir, "out/summary.json"), "utf8"))).toMatchObject({ status: "awaiting_review", yieldDifference: null });
  expect(await readFile(path.join(dir, "out/index.html"), "utf8")).toContain("SOURCE_MARKER");
  expect((await stat(path.join(dir, "out/index.html"))).mode & 0o777).toBe(0o600);
}));

it("CLI never overwrites an existing report directory", () => fixture(async (dir, args) => {
  await mkdir(path.join(dir, "out")); await writeFile(path.join(dir, "out/keep.txt"), "existing");
  expect((await run(args)).code).toBe(1);
  expect(await readFile(path.join(dir, "out/keep.txt"), "utf8")).toBe("existing");
  await expect(stat(path.join(dir, "out/index.html"))).rejects.toMatchObject({ code: "ENOENT" });
}));

it("CLI refuses partial API results before creating a review board", () => fixture(async (dir, args) => {
  const file = path.join(dir, "responses.json"); const report = JSON.parse(await readFile(file, "utf8"));
  report.complete = false; await writeFile(file, JSON.stringify(report));
  expect((await run(args)).code).toBe(1);
  await expect(stat(path.join(dir, "out"))).rejects.toMatchObject({ code: "ENOENT" });
}));

it("CLI reuses the exact assignment to summarize source-confirmed reviewer annotations", () => fixture(async (dir, args) => {
  expect((await run(args)).code).toBe(0);
  const assignment = JSON.parse(await readFile(path.join(dir, "out/assignment.json"), "utf8"));
  const annotations = path.join(dir, "notes.json");
  await writeFile(annotations, JSON.stringify({ version: 1, auditId: assignment.auditId, reviewer: "fixture",
    confirmedSourceReview: true, answers: assignment.cards.map((card: { reviewId: string }) => ({ reviewId: card.reviewId,
      verdict: "product", notes: "", durationMs: null })) }));
  const next = args.map(arg => arg === path.join(dir, "out") ? path.join(dir, "reviewed") : arg);
  expect((await run([...next, "--annotations", annotations])).code).toBe(0);
  expect(JSON.parse(await readFile(path.join(dir, "reviewed/summary.json"), "utf8"))).toMatchObject({ status: "reviewed", yieldDifference: 0, secondsPerFindingDifference: null });
}));
