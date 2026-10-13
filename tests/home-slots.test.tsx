import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));

const { default: NoSeasonFooterDefault } = await import("@/app/(public)/[locale]/(content)/@seasonfooter/default");
const { OnlyOnHome } = await import("@/components/home/OnlyOnHome");

/**
 * 푸터 시즌 줄 슬롯이 메인 밖으로 새지 않게 하는 규약.
 *
 * 병렬 라우트는 소프트 내비게이션(next/link)에서 슬롯의 이전 활성 상태를 유지하고,
 * default.tsx는 새로고침 같은 하드 내비게이션에서만 쓰인다. 소프트 내비게이션 쪽은 OnlyOnHome 이 경로로 가린다.
 * 슬롯에 [...catchAll]/page.tsx 를 두면 없는 주소의 루트 404 서버 렌더가 오류 셸로 깨진다(ROB-01).
 */
const SLOTS = ["@seasonfooter"] as const;

beforeEach(() => {
  mocks.pathname = "/";
});

describe("홈 병렬 슬롯", () => {
  it("슬롯마다 default 를 두고, catch-all 페이지는 두지 않는다", () => {
    for (const slot of SLOTS) {
      expect(existsSync(join(process.cwd(), "app", "(public)", "[locale]", "(content)", slot, "default.tsx"))).toBe(true);
      expect(existsSync(join(process.cwd(), "app", "(public)", "[locale]", "(content)", slot, "[...catchAll]"))).toBe(false);
    }
  });

  it("메인이 아닌 경로를 새로 열면 아무것도 그리지 않는다", () => {
    expect(NoSeasonFooterDefault()).toBeNull();
  });

  it("홈에서 링크로 옮긴 뒤 슬롯에 남은 줄은 경로로 가린다", () => {
    const line = <OnlyOnHome><p>시즌 줄</p></OnlyOnHome>;
    expect(renderToStaticMarkup(line)).toBe("<p>시즌 줄</p>");
    for (const path of ["/p/some-product", "/rankings", "/admin", "/zzz-not-here"]) {
      mocks.pathname = path;
      expect(renderToStaticMarkup(line)).toBe("");
    }
  });
});
