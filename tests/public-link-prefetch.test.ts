import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/**
 * 공개 화면의 링크는 동적 화면을 미리 받지 않는다(2026-10-06 실측).
 *
 * 동적 화면의 미리 받기는 경로 틀과 메타데이터만 받아 와 클릭이 빨라지지 않는데, 홈 한 번에 원 서버로
 * 요청 약 48개, 상세 한 번에 약 11개가 나갔다 — 홈 원 서버 비용의 약 80%였다. `_rsc` 주소가 출발 화면마다
 * 갈라져 Cloudflare 가 저장해도 잘 맞지 않는다. 정적인 /launch 만 기본값을 둔다.
 */
const ROOTS = ["app", "components"];
const SKIP = /(^|\/)(admin)(\/|$)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (SKIP.test(path)) return [];
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

it("공개 화면의 동적 화면 링크는 prefetch={false} 를 단다", () => {
  const missing: string[] = [];
  for (const file of ROOTS.flatMap(files)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/<Link\b[^>]*>/g)) {
      const tag = match[0];
      if (tag.includes("prefetch=") || /href="\/launch/.test(tag)) continue;
      missing.push(`${file}: ${tag.slice(0, 80)}`);
    }
  }
  expect(missing).toEqual([]);
});
