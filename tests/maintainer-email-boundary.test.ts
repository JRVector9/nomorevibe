import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 커밋 작성자 이메일(0186)은 관리자 전용이다 — 표·읽기 모듈을 부르는 소스를 정해진 곳으로 묶는다.
 * 공개 화면(app/(public))·공개 API·피드·탐색 캐시·컴포넌트가 이 표를 읽기 시작하면 여기서 막는다.
 */
const ROOTS = ["app", "components", "lib", "scripts", "proxy.ts", "instrumentation.ts"];
const NEEDLES = [/repositoryMaintainerEmails/, /repository_maintainer_emails/, /maintainer-emails-admin/, /makers\/maintainer-emails["']/, /maintainer-email-schema/];
const ALLOWED = new Set([
  "lib/db/maintainer-email-schema.ts",
  "lib/db/schema.ts",
  "lib/domain/makers/maintainer-emails.ts",
  "lib/domain/makers/maintainer-emails-admin.ts",
  "lib/jobs/products/ai-level-refresh.ts",
  "app/(operator)/admin/products/[slug]/page.tsx",
  "app/(operator)/admin/products/[slug]/MaintainerEmails.tsx",
]);

function files(path: string): string[] {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return /\.(?:tsx?|mjs|js)$/.test(path) ? [path] : [];
  return readdirSync(path).filter(name => name !== "node_modules" && !name.startsWith(".")).flatMap(name => files(join(path, name)));
}

describe("커밋 작성자 이메일 — 관리자 전용 경계", () => {
  it("표와 읽기 모듈은 허용된 파일만 부른다", () => {
    const users = ROOTS.flatMap(files).filter(path => NEEDLES.some(needle => needle.test(readFileSync(path, "utf8"))));
    expect(users.filter(path => !ALLOWED.has(path))).toEqual([]);
    // 허용 목록이 실제로 쓰이는지(이름이 바뀌면 경계가 헐거워진다)
    expect([...ALLOWED].filter(path => !users.includes(path))).toEqual([]);
  });

  it("관리자 화면 부품은 브라우저 부품이 아니고, 읽기 모듈은 server-only 다", () => {
    expect(readFileSync("app/(operator)/admin/products/[slug]/MaintainerEmails.tsx", "utf8")).not.toMatch(/^["']use client["']/m);
    expect(readFileSync("lib/domain/makers/maintainer-emails-admin.ts", "utf8")).toMatch(/^import "server-only";/);
  });

  it("관리자 화면은 관리자 확인 뒤에만 주소를 읽는다", () => {
    const page = readFileSync("app/(operator)/admin/products/[slug]/page.tsx", "utf8");
    const guard = page.indexOf('if (!admin) redirect("/admin/login")');
    expect(guard).toBeGreaterThan(0);
    expect(page.indexOf("maintainerEmailsForRepoUrl(")).toBeGreaterThan(guard);
  });

  it("탐색 캐시는 여전히 주소를 지운다", () => {
    expect(readFileSync("lib/crawl/discovery-contract.ts", "utf8")).toMatch(/redacted@invalid/);
  });
});
