import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_LINKS, jobHref, STATUS_TABS } from "@/app/admin/status/action-links";
import { PRODUCT_FILTERS, PRODUCT_SORTS } from "@/app/admin/products/filters";
import { SECOND_FILTER_KEYS, STAGE_KEYS } from "@/app/admin/review/stages";
import { REVIEW_SORTS } from "@/lib/crawl/admin-review";
import { JOB_NAMES } from "@/lib/jobs/catalog";

/**
 * 운영센터 "조치할 일"의 링크가 받는 화면에 실제로 닿는가(2026-10-08 감사 ADM-03).
 *
 * 전에는 없는 앵커(/admin#second-review)와 거르기 없는 목록(/admin/products)으로 보냈다. 화면이 내놓을 수 있는
 * 주소를 모두 모아(ACTION_LINKS, 모든 작업의 jobHref) 경로의 page.tsx, 쿼리 값(받는 화면이 읽는 상수), 앵커 id 가
 * 있는지 본다. page.tsx 가 ACTION_LINKS 밖의 주소를 쓰지 않는지도 소스로 본다.
 */
const root = path.resolve(__dirname, "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

/** 감사 화면의 탭은 page.tsx 안의 상수라 가져올 수 없다 — 소스에서 키를 읽는다 */
function auditTabs(): string[] {
  const body = source("app/admin/audit/page.tsx").match(/const TABS = \{([^}]*)\}/)?.[1] ?? "";
  return [...body.matchAll(/(\w+):/g)].map((match) => match[1]);
}

/** 경로마다 받는 쿼리와 그 값 — 받는 화면이 실제로 읽는 상수 */
const QUERY: Record<string, Record<string, readonly string[]>> = {
  "/admin": {},
  "/admin/status": { tab: STATUS_TABS, job: JOB_NAMES },
  "/admin/review": { stage: STAGE_KEYS, sort: REVIEW_SORTS.filter(Boolean), second: SECOND_FILTER_KEYS },
  "/admin/products": { filter: Object.keys(PRODUCT_FILTERS), sort: Object.keys(PRODUCT_SORTS) },
  "/admin/audit": { tab: auditTabs() },
  "/admin/github-accounts": {},
};

/** 그 경로의 화면을 그리는 파일들 — 하위 경로(자기 page.tsx 가 있는 폴더)는 빼고 */
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return existsSync(path.join(full, "page.tsx")) ? [] : routeFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}
const anchorsOf = (pathname: string) => new Set(routeFiles(path.join(root, "app", pathname))
  .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\bid="([\w-]+)"/g)].map((match) => match[1])));

function assertResolves(href: string) {
  const url = new URL(href, "http://localhost");
  expect(existsSync(path.join(root, "app", url.pathname, "page.tsx")), `${href} — 경로가 없다`).toBe(true);
  const accepted = QUERY[url.pathname];
  expect(accepted, `${href} — 받는 쿼리를 이 테스트에 적어야 한다`).toBeDefined();
  for (const [key, value] of url.searchParams) {
    expect(accepted[key], `${href} — ${url.pathname} 은 ?${key} 를 읽지 않는다`).toBeDefined();
    expect(accepted[key], `${href} — ?${key}=${value} 는 없는 값이다`).toContain(value);
  }
  if (url.hash) expect([...anchorsOf(url.pathname)], `${href} — 앵커가 없다`).toContain(url.hash.slice(1));
}

describe("조치할 일 링크", () => {
  it("모아 둔 주소마다 경로·쿼리 값·앵커가 받는 화면에 있다", () => {
    for (const href of Object.values(ACTION_LINKS)) assertResolves(href);
  });

  it("모든 작업의 상세 링크가 작업 흐름 탭의 그 작업을 연다", () => {
    for (const name of JOB_NAMES) assertResolves(jobHref(name));
    expect(jobHref("uptime-ping")).toBe("/admin/status?tab=jobs&job=uptime-ping");
  });

  it("운영센터는 모아 둔 주소만 쓰고, 이름으로 고른 작업은 실제 작업이다", () => {
    const page = source("app/admin/status/page.tsx");
    const hrefs = [...page.matchAll(/\bhref:\s*([^}\n]+)/g)].map((match) => match[1]);
    expect(hrefs.length).toBeGreaterThan(20);
    for (const value of hrefs) expect(value, value).toMatch(/^(ACTION_LINKS\.|jobHref\(|[\w.!\s=><[\]0-9]+\?\s*(ACTION_LINKS\.|jobHref\())/);
    expect(page).not.toMatch(/\bhref:\s*["'`]/);
    for (const [, name] of page.matchAll(/jobHref\("([^"]+)"\)/g)) expect(JOB_NAMES).toContain(name);
    // 받는 쪽이 ?tab= ?job= 을 실제로 읽는다
    expect(page).toContain("STATUS_TABS");
    expect(page).toMatch(/params\.job/);
    expect(source("app/admin/status/OperationsCenter.tsx")).toContain("initialJob");
  });

  it("고쳐 둔 세 곳 — 응답 없음 거르기, 2차 설정 앵커, 직접 판단 구간", () => {
    expect(ACTION_LINKS.productsDown).toBe(`/admin/products?filter=${encodeURIComponent("응답 없음")}`);
    expect(ACTION_LINKS.secondSettings).toBe("/admin#second");
    expect(ACTION_LINKS.reviewHuman).toBe("/admin/review?stage=human&sort=wait#review-list");
  });

  it("없는 쿼리 값·앵커는 걸러낸다(검사기 자체의 확인)", () => {
    expect(() => assertResolves("/admin#second-review")).toThrow();
    expect(() => assertResolves("/admin/products?filter=없는거르기")).toThrow();
    expect(() => assertResolves("/admin/status?tab=jobs&job=no-such-job")).toThrow();
  });
});
