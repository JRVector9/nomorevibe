import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const script = readFileSync("scripts/ops/release-order/capacity-control.sh", "utf8");
let dir: string;
// A fake node records argv and the derived env; the real one is used only for the URL rewrite.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "capacity-control-"));
  writeFileSync(join(dir, "node"), `#!/bin/sh
if [ "$1" = "-e" ]; then exec ${process.execPath} "$@"; fi
printf '%s\\n' "$PIPELINE_CONTROL_DATABASE_URL" > "${dir}/url"; printf '%s\\n' "$@" > "${dir}/argv"; echo '{"ok":true}'
`);
  chmodSync(join(dir, "node"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync("/bin/sh", ["-s", "--", ...args], { input: script, encoding: "utf8",
  env: { PATH: `${dir}:/usr/bin:/bin`, NODE_ENV: "test", NMV_APP_DIR: dir, DATABASE_URL: "postgres://user:secret@pgbouncer:6432/other?sslmode=require&application_name=x" } });

it("배포 뒤 OPEN은 정식 pipeline-control CAS로만 하고 기본은 dry-run, 직접 primary로 host만 바꾼다", () => {
  const dry = run("open", "1", "8", "jr", "release-order-open");
  expect(dry.status).toBe(0); expect(dry.stderr).toBe("");
  expect(readFileSync(join(dir, "argv"), "utf8").trim().split("\n")).toEqual(["--import", "tsx", "scripts/ops/pipeline-control.ts", "capacity", "mode",
    "--to=open", "--from-mode=draining", "--expect-epoch=1", "--expect-revision=8", "--operator=jr", "--reason=release-order-open", "--json"]);
  expect(readFileSync(join(dir, "url"), "utf8").trim()).toBe("postgres://user:secret@100.99.209.55:5432/nomorevibe?sslmode=require");
  expect(dry.stdout).not.toContain("secret");
  expect(run("open", "1", "8", "jr", "release-order-open", "--execute").status).toBe(0);
  expect(readFileSync(join(dir, "argv"), "utf8").trim().split("\n").at(-1)).toBe("--execute");
  expect(run("status").status).toBe(0);
  expect(readFileSync(join(dir, "argv"), "utf8").trim().split("\n")).toEqual(["--import", "tsx", "scripts/ops/pipeline-control.ts", "status", "--json"]);
  expect(run("routes").status).toBe(0);
  expect(readFileSync(join(dir, "argv"), "utf8").trim().split("\n")).toEqual(["--import", "tsx", "scripts/ops/pipeline-control.ts", "status"]);
});
it("deferred route 허용·다른 플래그·잘못된 숫자·공백 사유·임의 명령을 거절한다", () => {
  for (const args of [["open", "1", "8", "jr", "x", "--allow-deferred-routes"], ["open", "0", "8", "jr", "x"], ["open", "1", "8", "jr", "two words"],
    ["open", "1", "8", "jr;id", "x"], ["drain", "1", "8", "jr", "x"], ["status", "extra"], ["routes", "--json"], ["open", "1", "8", "jr"]]) {
    const result = run(...args);
    expect(result.status).toBe(2);
  }
});
