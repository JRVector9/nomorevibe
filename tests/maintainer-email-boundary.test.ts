import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 제작자 커밋 이메일(0194)은 관리자 전용이다 — 표·거부 목록·읽기 모듈을 부르는 소스를 정해진 곳으로 묶는다.
 * 공개 화면(app/(public))·공개 API·피드·탐색 캐시·컴포넌트가 이 표를 읽기 시작하면 여기서 막는다.
 */
const ROOTS = ["app", "components", "lib", "scripts", "proxy.ts", "instrumentation.ts"];
const NEEDLES = [/repositoryMaintainerEmails/, /repository_maintainer_emails/, /maintainerEmailDenials/, /maintainer_email_denials/,
  /maintainer-emails-admin/, /makers\/maintainer-emails["']/, /maintainer-email-schema/];
const ALLOWED = new Set([
  "lib/db/maintainer-email-schema.ts",
  "lib/domain/makers/maintainer-emails.ts",
  "lib/domain/makers/maintainer-emails-admin.ts",
  // 수집(쓰기만): 제작자 주소를 거르고 거부 목록을 본 뒤 쓴다
  "lib/jobs/products/ai-level-refresh.ts",
  // 1년 보관 정리(지우기만): 주소 칸을 읽지 않는다
  "lib/operations/db-retention.ts",
  "app/(operator)/admin/products/[slug]/page.tsx",
  "app/(operator)/admin/products/[slug]/MaintainerEmails.tsx",
  "app/(operator)/admin/products/[slug]/actions.ts",
]);
const PANEL = "app/(operator)/admin/products/[slug]/MaintainerEmails.tsx";
const DENY_BUTTON = "app/(operator)/admin/products/[slug]/MaintainerEmailDeny.tsx";
const ACTIONS = "app/(operator)/admin/products/[slug]/actions.ts";

function files(path: string): string[] {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return /\.(?:tsx?|mjs|js)$/.test(path) ? [path] : [];
  return readdirSync(path).filter(name => name !== "node_modules" && !name.startsWith(".")).flatMap(name => files(join(path, name)));
}

describe("제작자 이메일 — 관리자 전용 경계", () => {
  it("표·거부 목록과 읽기 모듈은 허용된 파일만 부른다", () => {
    const users = ROOTS.flatMap(files).filter(path => NEEDLES.some(needle => needle.test(readFileSync(path, "utf8"))));
    expect(users.filter(path => !ALLOWED.has(path))).toEqual([]);
    // 허용 목록이 실제로 쓰이는지(이름이 바뀌면 경계가 헐거워진다)
    expect([...ALLOWED].filter(path => !users.includes(path))).toEqual([]);
  });

  it("표는 공용 schema 묶음(lib/db/schema.ts)에 넣지 않는다 — 모든 코드가 부르는 묶음이라 경계가 무너지고, CI 증분 tsc 기록도 깨져 4GB 안에 못 든다", () => {
    expect(readFileSync("lib/db/schema.ts", "utf8")).not.toMatch(/maintainer-email|maintainer_email/);
  });

  it("관리자 화면 부품은 브라우저 부품이 아니고, 읽기 모듈은 server-only 다", () => {
    expect(readFileSync(PANEL, "utf8")).not.toMatch(/^["']use client["']/m);
    expect(readFileSync("lib/domain/makers/maintainer-emails-admin.ts", "utf8")).toMatch(/^import "server-only";/);
  });

  it("브라우저 부품(지우기 단추)에는 주소를 넘기지 않는다 — 거부 열쇠와 가린 주소만", () => {
    expect(readFileSync(PANEL, "utf8")).toContain("<MaintainerEmailDeny slug={slug} denyKey={row.denyKey} masked={row.masked} />");
    const button = readFileSync(DENY_BUTTON, "utf8");
    expect(button).toMatch(/^"use client";/);
    expect(button).toContain("{ slug, denyKey, masked }: { slug: string; denyKey: string; masked: string }");
  });

  it("관리자 화면은 관리자 확인 뒤에만 주소를 읽고, 지우기 동작도 관리자 확인 뒤에만 지운다", () => {
    const page = readFileSync("app/(operator)/admin/products/[slug]/page.tsx", "utf8");
    const guard = page.indexOf('if (!admin) redirect("/admin/login")');
    expect(guard).toBeGreaterThan(0);
    expect(page.indexOf("maintainerEmailsForRepoUrl(")).toBeGreaterThan(guard);
    const actions = readFileSync(ACTIONS, "utf8");
    const body = actions.slice(actions.indexOf("export const denyMaintainerEmailAction = webWriteAction("));
    expect(body.indexOf("if (!admin) return")).toBeGreaterThan(0);
    expect(body.indexOf("await denyMaintainerEmail(")).toBeGreaterThan(body.indexOf("if (!admin) return"));
  });

  it("탐색 캐시는 여전히 주소를 지운다", () => {
    expect(readFileSync("lib/crawl/discovery-contract.ts", "utf8")).toMatch(/redacted@invalid/);
  });
});
