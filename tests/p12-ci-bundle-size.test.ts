import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brotliSizer, compareToBaseline, measureRoutes, updatedBaseline } from "@/scripts/bundle-size.mjs";

const SCRIPT = path.resolve(__dirname, "../scripts/bundle-size.mjs");

// next build(Turbopack)가 남기는 .next/diagnostics/route-bundle-stats.json 과 같은 모양의 작은 예시
const STATS = [
  { route: "/", firstLoadUncompressedJsBytes: 300, firstLoadChunkPaths: [".next/static/chunks/shared.js", ".next/static/chunks/home.js"] },
  { route: "/p/[slug]", firstLoadUncompressedJsBytes: 200, firstLoadChunkPaths: [".next/static/chunks/shared.js", ".next/static/chunks/detail.js", ".next/static/chunks/style.css"] },
  { route: "/admin", firstLoadUncompressedJsBytes: 900, firstLoadChunkPaths: [".next/static/chunks/shared.js"] },
];
const CHUNKS: Record<string, string> = {
  ".next/static/chunks/shared.js": "function shared(){return 1}".repeat(4),
  ".next/static/chunks/home.js": "const home = [1,2,3].map(String);",
  ".next/static/chunks/detail.js": "export const detail = 'detail';",
};
const br = (text: string) => brotliCompressSync(Buffer.from(text)).length;

describe("measureRoutes — 화면마다 처음 받는 JS 를 br 로 더한다", () => {
  it("기준선에 있는 화면만, .js 청크만 잰다", () => {
    const reads: string[] = [];
    const sizeOf = brotliSizer((file: string) => { reads.push(file); return Buffer.from(CHUNKS[file]); });
    expect(measureRoutes(STATS, ["/", "/p/[slug]"], sizeOf)).toEqual([
      { route: "/", chunks: 2, rawBytes: 300, brotliBytes: br(CHUNKS[".next/static/chunks/shared.js"]) + br(CHUNKS[".next/static/chunks/home.js"]) },
      { route: "/p/[slug]", chunks: 2, rawBytes: 200, brotliBytes: br(CHUNKS[".next/static/chunks/shared.js"]) + br(CHUNKS[".next/static/chunks/detail.js"]) },
    ]);
    // 공통 청크는 한 번만 누른다
    expect(reads.filter((file) => file.endsWith("shared.js"))).toHaveLength(1);
  });

  it("빌드 통계에 없는 화면은 brotliBytes 가 null 이다", () => {
    expect(measureRoutes(STATS, ["/launch"], () => 1)).toEqual([{ route: "/launch", chunks: 0, rawBytes: null, brotliBytes: null }]);
  });
});

describe("compareToBaseline — 허용 폭을 넘거나 화면이 없으면 실패", () => {
  const baseline = { tolerance: 0.1, routes: { "/": 1000, "/p/[slug]": 1000, "/launch": 1000 } };
  it("한도(기준 × 1.1)까지는 통과, 넘으면 over, 없으면 missing", () => {
    const rows = compareToBaseline([
      { route: "/", chunks: 1, rawBytes: 1, brotliBytes: 1100 },
      { route: "/p/[slug]", chunks: 1, rawBytes: 1, brotliBytes: 1101 },
      { route: "/launch", chunks: 0, rawBytes: null, brotliBytes: null },
    ], baseline);
    expect(rows.map((row: { route: string; limit: number; status: string }) => [row.route, row.limit, row.status])).toEqual([["/", 1100, "ok"], ["/p/[slug]", 1100, "over"], ["/launch", 1100, "missing"]]);
  });

  it("새 기준선은 잰 값으로 바꾸고 허용 폭은 둔다 — 없는 화면이 있으면 고치지 않는다", () => {
    expect(updatedBaseline([{ route: "/", chunks: 1, rawBytes: 1, brotliBytes: 1234 }], { note: "n", tolerance: 0.1, routes: { "/": 1000 } }))
      .toEqual({ note: "n", tolerance: 0.1, routes: { "/": 1234 } });
    expect(() => updatedBaseline([{ route: "/launch", chunks: 0, rawBytes: null, brotliBytes: null }], baseline)).toThrow(/\/launch/);
  });
});

describe("CI 에서 그대로 부른다 — 빌드 산출물 예시로", () => {
  let dir: string;
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  const writeBaseline = (routes: Record<string, number>) =>
    writeFileSync(path.join(dir, "scripts/bundle-baseline.json"), JSON.stringify({ tolerance: 0.1, routes }));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nmv-bundle-size-"));
    mkdirSync(path.join(dir, ".next/diagnostics"), { recursive: true });
    mkdirSync(path.join(dir, ".next/static/chunks"), { recursive: true });
    mkdirSync(path.join(dir, "scripts"));
    writeFileSync(path.join(dir, ".next/diagnostics/route-bundle-stats.json"), JSON.stringify(STATS));
    for (const [file, text] of Object.entries(CHUNKS)) writeFileSync(path.join(dir, file), text);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("기준선 안이면 0, 넘으면 1 로 끝난다", () => {
    const home = br(CHUNKS[".next/static/chunks/shared.js"]) + br(CHUNKS[".next/static/chunks/home.js"]);
    writeBaseline({ "/": home });
    expect(run()).toMatchObject({ status: 0 });
    writeBaseline({ "/": Math.floor(home / 2) });
    const over = run();
    expect(over.status).toBe(1);
    expect(over.stderr).toContain("기준선");
  });

  it("빌드 통계가 없으면 실패한다", () => {
    writeBaseline({ "/": 1 });
    writeFileSync(path.join(dir, ".next/diagnostics/route-bundle-stats.json"), "");
    expect(run().status).toBe(1);
  });

  it("--update 는 지금 잰 값으로 기준선을 고친다", () => {
    writeBaseline({ "/": 1, "/p/[slug]": 1 });
    expect(run("--update").status).toBe(0);
    const updated = JSON.parse(readFileSync(path.join(dir, "scripts/bundle-baseline.json"), "utf8"));
    expect(updated.tolerance).toBe(0.1);
    expect(updated.routes["/"]).toBeGreaterThan(1);
    expect(run().status).toBe(0);
  });
});
