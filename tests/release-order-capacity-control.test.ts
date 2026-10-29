import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = readFileSync("scripts/ops/release-order/capacity-control.sh", "utf8");
const LOCK = '{"name":"nomorevibe","lockfileVersion":3}\n';
let dir: string, app: string, base: string;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
// The image /app as built: package-lock and node_modules, but no scripts/ops (.dockerignore line 7).
// A fake node records argv, cwd and the derived env, and fails like the real one when the script file is absent.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "capacity-control-"));
  app = join(dir, "app"); base = join(dir, "stage");
  mkdirSync(join(app, "node_modules"), { recursive: true }); mkdirSync(join(app, "scripts"));
  writeFileSync(join(app, "package-lock.json"), LOCK); mkdirSync(base);
  writeFileSync(join(dir, "node"), `#!/bin/sh
if [ "$1" = "-e" ]; then exec ${process.execPath} "$@"; fi
if [ "$1" = "-v" ]; then echo v24.22.1; exit 0; fi
[ -f scripts/ops/pipeline-control.ts ] || { echo "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '$PWD/scripts/ops/pipeline-control.ts'" >&2; exit 1; }
pwd > "${dir}/cwd"; printf '%s\\n' "$PIPELINE_CONTROL_DATABASE_URL" > "${dir}/url"; printf '%s\\n' "$@" > "${dir}/argv"; echo '{"ok":true}'
`);
  chmodSync(join(dir, "node"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync("/bin/sh", ["-s", "--", ...args], { input: script, encoding: "utf8",
  env: { PATH: `${dir}:/usr/bin:/bin`, NODE_ENV: "test", NMV_APP_DIR: app, NMV_STAGE_BASE: base,
    DATABASE_URL: "postgres://user:secret@pgbouncer:6432/other?sslmode=require&application_name=x" } });
/** git archive 모양의 tar(C5와 같은 경로 이름)를 base/src.tar로 만든다. */
function makeTar(files: Record<string, string>) {
  const src = mkdtempSync(join(dir, "tarsrc-"));
  for (const [name, body] of Object.entries(files)) { mkdirSync(join(src, name, ".."), { recursive: true }); writeFileSync(join(src, name), body); }
  const made = spawnSync("tar", ["-c", "-f", join(base, "src.tar"), "-C", src, ...Object.keys(files)]);
  expect(made.status).toBe(0);
  return sha(join(base, "src.tar"));
}
const reviewed = () => makeTar({ "package-lock.json": LOCK, "package.json": "{}\n", "scripts/ops/pipeline-control.ts": "export {};\n" });
const argv = () => readFileSync(join(dir, "argv"), "utf8").trim().split("\n");
const error = (result: { stderr: string }) => JSON.parse(result.stderr.trim().split("\n").at(-1)!).error;
const onlyTar = () => expect(readdirSync(base)).toEqual(["src.tar"]);

it("운영 이미지 빌드는 scripts/ops를 빼므로 이 실행기는 /app의 스크립트에 기대면 안 된다", () => {
  expect(readFileSync(".dockerignore", "utf8").split("\n").map((line) => line.trim())).toContain("scripts/ops");
  expect(existsSync(join(app, "scripts/ops"))).toBe(false);
  for (const args of [["status"], ["routes"], ["open", "1", "8", "jr", "x"]]) {
    const result = run(...args);
    expect(result.status).toBe(2); expect(error(result)).toBe("source_not_staged");
  }
  expect(existsSync(join(dir, "argv"))).toBe(false);
});

describe("스테이징한 검토 소스로만 실행한다", () => {
  it("stage 뒤 OPEN은 정식 pipeline-control CAS로만 하고 기본은 dry-run, 직접 primary로 host만 바꾼다", () => {
    const tarSha = reviewed();
    const staged = run("stage", tarSha);
    expect(staged.status).toBe(0); expect(staged.stderr).toBe("");
    expect(JSON.parse(staged.stdout)).toEqual({ staged: join(base, "src"), tarSha256: tarSha, node: "v24.22.1", lock: "same_as_image" });
    expect(lstatSync(join(base, "src/node_modules")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(base, "src/node_modules"))).toBe(join(app, "node_modules"));
    expect(readdirSync(base).sort()).toEqual(["src", "src.tar"]);

    const dry = run("open", "1", "8", "jr", "release-order-open");
    expect(dry.status).toBe(0); expect(dry.stderr).toBe("");
    expect(readFileSync(join(dir, "cwd"), "utf8").trim()).toBe(join(base, "src"));
    expect(argv()).toEqual(["--import", "tsx", "scripts/ops/pipeline-control.ts", "capacity", "mode",
      "--to=open", "--from-mode=draining", "--expect-epoch=1", "--expect-revision=8", "--operator=jr", "--reason=release-order-open", "--json"]);
    expect(readFileSync(join(dir, "url"), "utf8").trim()).toBe("postgres://user:secret@100.99.209.55:5432/nomorevibe?sslmode=require");
    expect(dry.stdout).not.toContain("secret");
    expect(run("open", "1", "8", "jr", "release-order-open", "--execute").status).toBe(0);
    expect(argv().at(-1)).toBe("--execute");
    expect(run("status").status).toBe(0);
    expect(argv()).toEqual(["--import", "tsx", "scripts/ops/pipeline-control.ts", "status", "--json"]);
    expect(run("routes").status).toBe(0);
    expect(argv()).toEqual(["--import", "tsx", "scripts/ops/pipeline-control.ts", "status"]);

    const again = run("stage", tarSha);   // 응답이 불명확해 다시 친 stage는 같은 tar면 그대로 둔다
    expect(again.status).toBe(0); expect(JSON.parse(again.stdout)).toMatchObject({ existing: true, tarSha256: tarSha });
  });

  it("실제 git archive tar(pax 머리 포함, C5와 같은 경로)도 같은 lock이면 스테이징한다", () => {
    writeFileSync(join(app, "package-lock.json"), readFileSync("package-lock.json"));
    const made = spawnSync("git", ["archive", "--format=tar", "-o", join(base, "src.tar"), "HEAD", "scripts/ops/pipeline-control.ts", "package-lock.json"]);
    expect(made.status).toBe(0);
    const result = run("stage", sha(join(base, "src.tar")));
    expect(result.stderr).toBe(""); expect(result.status).toBe(0);
    expect(run("status").status).toBe(0);
    expect(readFileSync(join(dir, "cwd"), "utf8").trim()).toBe(join(base, "src"));
  });

  // 운영 컨테이너는 alpine(busybox sh·tar·sha256sum)이다. busybox가 있는 곳에서는 같은 흐름을 busybox 도구만으로 돌린다.
  it.skipIf(!existsSync("/usr/bin/busybox"))("busybox 도구만으로도 stage·lock 거절·status가 같다", () => {
    const bb = join(dir, "bb"); mkdirSync(bb);
    for (const tool of ["sh", "tar", "sha256sum", "cut", "grep", "mkdir", "ln", "mv", "rm", "cat", "readlink", "pwd"]) {
      spawnSync("ln", ["-s", "/usr/bin/busybox", join(bb, tool)]);
    }
    const bbRun = (...args: string[]) => spawnSync(join(bb, "sh"), ["-s", "--", ...args], { input: script, encoding: "utf8",
      env: { PATH: `${dir}:${bb}`, NODE_ENV: "test", NMV_APP_DIR: app, NMV_STAGE_BASE: base, DATABASE_URL: "postgres://user:secret@pgbouncer:6432/other" } });
    const bad = makeTar({ "package-lock.json": "{}\n", "scripts/ops/pipeline-control.ts": "export {};\n" });
    expect(error(bbRun("stage", bad))).toBe("package_lock_differs_from_image"); onlyTar();
    writeFileSync(join(app, "package-lock.json"), readFileSync("package-lock.json"));   // C5와 같은 git archive tar(pax 머리)
    expect(spawnSync("git", ["archive", "--format=tar", "-o", join(base, "src.tar"), "HEAD", "scripts/ops/pipeline-control.ts", "package-lock.json"]).status).toBe(0);
    const staged = bbRun("stage", sha(join(base, "src.tar")));
    expect(staged.stderr).toBe(""); expect(staged.status).toBe(0);
    expect(bbRun("status").status).toBe(0);
    expect(readFileSync(join(dir, "cwd"), "utf8").trim()).toBe(join(base, "src"));
  });

  it("tar sha256이 다르면 아무것도 쓰지 않고 멈춘다", () => {
    reviewed();
    const result = run("stage", "0".repeat(64));
    expect(result.status).toBe(2); expect(error(result)).toBe("source_tar_sha_mismatch"); onlyTar();
    expect(error(run("stage", "not-a-sha"))).toBe("sha256_required");
  });

  it("검토한 SHA의 package-lock이 이미지의 것과 다르면 아무것도 쓰지 않고 멈춘다", () => {
    const tarSha = makeTar({ "package-lock.json": '{"name":"nomorevibe","lockfileVersion":3,"x":1}\n', "scripts/ops/pipeline-control.ts": "export {};\n" });
    const result = run("stage", tarSha);
    expect(result.status).toBe(2); expect(error(result)).toBe("package_lock_differs_from_image"); onlyTar();
    expect(error(run("status"))).toBe("source_not_staged");
  });

  it("tar에 pipeline-control이 없거나 이미지 /app에 node_modules가 없으면 남기는 것 없이 거절한다", () => {
    const tarSha = makeTar({ "package-lock.json": LOCK, "scripts/other.ts": "export {};\n" });
    const result = run("stage", tarSha);
    expect(result.status).toBe(2); expect(error(result)).toBe("source_tar_unusable"); onlyTar();
    const good = reviewed();
    rmSync(join(app, "node_modules"), { recursive: true });
    expect(error(run("stage", good))).toBe("image_app_missing"); onlyTar();
  });

  it("다른 tar로 이미 스테이징한 폴더는 덮어쓰지 않는다", () => {
    expect(run("stage", reviewed()).status).toBe(0);
    const other = makeTar({ "package-lock.json": LOCK, "scripts/ops/pipeline-control.ts": "export const changed = 1;\n" });
    const result = run("stage", other);
    expect(result.status).toBe(2); expect(error(result)).toBe("source_dir_exists_with_other_tar");
    expect(readFileSync(join(base, "src/scripts/ops/pipeline-control.ts"), "utf8")).toBe("export {};\n");
  });

  it("스테이징 뒤 이미지 lock이 달라지면(다른 컨테이너·교체된 /app) 실행하지 않는다", () => {
    expect(run("stage", reviewed()).status).toBe(0);
    writeFileSync(join(app, "package-lock.json"), '{"changed":true}\n');
    for (const args of [["status"], ["routes"], ["open", "1", "8", "jr", "x"]]) expect(error(run(...args))).toBe("package_lock_differs_from_image");
    expect(existsSync(join(dir, "argv"))).toBe(false);
  });
});

it("deferred route 허용·다른 플래그·잘못된 숫자·공백 사유·임의 명령을 거절한다", () => {
  expect(run("stage", reviewed()).status).toBe(0);
  for (const args of [["open", "1", "8", "jr", "x", "--allow-deferred-routes"], ["open", "0", "8", "jr", "x"], ["open", "1", "8", "jr", "two words"],
    ["open", "1", "8", "jr;id", "x"], ["drain", "1", "8", "jr", "x"], ["status", "extra"], ["routes", "--json"], ["open", "1", "8", "jr"],
    ["stage"], ["stage", "a".repeat(64), "extra"]]) {
    const result = run(...args);
    expect(result.status).toBe(2);
  }
  expect(existsSync(join(dir, "argv"))).toBe(false);
});

// 확정본 2단계 (b)의 awk가 routes 표에서 세는 non-serving 수는 OPEN이 막을 deferred_routes 수와 같아야 한다.
it("확정본 2(b)의 non-serving 집계는 OPEN의 deferred_routes 판정과 같다", async () => {
  const { deferredRoutes, formatControlStatus, statusRouteContracts } = await import("@/lib/operations/pipeline-control");
  const { modelCapacityPolicyHash } = await import("@/lib/llm/capacity");
  const { DEFAULT_CRAWL_SETTINGS } = await import("@/lib/crawl/settings-schema");
  const doc = readFileSync("docs/operations/2026-10-29-release-order.md", "utf8");
  const awk = doc.split("\n").find((line) => line.startsWith("awk '/^\\[capacity routes"));
  expect(awk).toBeDefined();
  const policy = { version: 1, globalLimit: 4, providerLimits: { abcllm: 4 }, groupLimits: { gateway: 4 }, poolLimits: { reviewer: 2, text: 2 },
    weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 60_000, reservationTtlMs: 30_000,
    routes: [{ routeId: "second-review", provider: "abcllm", model: "m", providerBudgetId: "abcllm", groupId: "gateway" }] } as const;
  const stage = (name: "ai1" | "ai2") => ({ stage: name, mode: "legacy" as const, drainingFrom: null, epoch: 1, contract: 1,
    live: 0, unsettled: 0, legacyJobLive: false, consumers: 1 });
  const snapshot = { now: "2026-10-29T00:00:00.000Z", fence: { state: "active", writerEpoch: 1 }, stages: [stage("ai1"), stage("ai2")],
    capacity: { mode: "draining", epoch: 1, revision: 7, policy, policyHash: modelCapacityPolicyHash(policy), waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, oldGeneration: 0 },
    http: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, reserved: 0, dispatched: 0, indeterminate: 0 },
    batch: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, policy: null, policyHash: null, liveJobs: 0, liveRoles: 0, liveItems: 0, liveSources: 0, liveAgentClaims: 0 },
    agentScan: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, live: 0, unsettled: 0, legacyJobLive: false, consumers: 0, queue: [] },
    recentInstances: [], uptimeSplitMode: "legacy", auditCampaign: null,
    reviewSettings: { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm", model: "primary-model" } } } as unknown as Parameters<typeof formatControlStatus>[0];
  const routes = statusRouteContracts(snapshot, null);
  const deferred = deferredRoutes(routes).length;
  expect(deferred).toBeGreaterThan(0); expect(routes.length).toBeGreaterThan(deferred);
  writeFileSync(join(dir, "routes.txt"), formatControlStatus(snapshot, null));
  const counted = spawnSync("/bin/sh", ["-c", awk!.replaceAll('"$W/pre/routes.txt"', JSON.stringify(join(dir, "routes.txt")))], { encoding: "utf8" });
  expect(counted.status).toBe(0);
  expect(counted.stdout.trim().split("\n").at(-1)).toBe(`routes ${routes.length} non_serving ${deferred}`);
});
