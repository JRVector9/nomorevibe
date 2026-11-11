import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/**
 * 공개 화면의 링크는 화면에 보이기만 해도 미리 받는 일을 하지 않는다(2026-10-06 실측).
 *
 * 동적 화면의 미리 받기는 경로 틀과 메타데이터만 받아 와 클릭이 빨라지지 않는데, 홈 한 번에 원 서버로
 * 요청 약 48개, 상세 한 번에 약 11개가 나갔다 — 홈 원 서버 비용의 약 80%였다. `_rsc` 주소가 출발 화면마다
 * 갈라져 Cloudflare 가 저장해도 잘 맞지 않는다.
 * /launch 도 이제 동적 화면이라(빌드 표 ƒ) 예외를 두지 않는다 — 화면마다 경로 틀·메타데이터 요청 2개만 더 나갔다(2026-11-11).
 * 누를 것 같은 링크만 받는 일은 components/IntentPrefetch.tsx 가 문서 전체에서 맡는다(tests/intent-prefetch.test.ts).
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

it("공개 화면의 링크는 prefetch={false} 를 단다", () => {
  const missing: string[] = [];
  for (const file of ROOTS.flatMap(files)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/<Link\b[^>]*>/g)) {
      const tag = match[0];
      if (tag.includes("prefetch={false}")) continue;
      missing.push(`${file}: ${tag.slice(0, 80)}`);
    }
  }
  expect(missing).toEqual([]);
});
