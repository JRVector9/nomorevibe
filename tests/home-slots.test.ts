import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import NoSeasonFooterCatchAll from "@/app/@seasonfooter/[...catchAll]/page";
import NoSeasonFooterDefault from "@/app/@seasonfooter/default";
import NoTopbarCatchAll from "@/app/@topbar/[...catchAll]/page";
import NoTopbarDefault from "@/app/@topbar/default";

/**
 * 슬롯을 닫는 파일이 사라지면 상단 숫자 줄과 푸터 시즌 줄이 다시 따라다닌다.
 *
 * 병렬 라우트는 소프트 내비게이션(next/link)에서 슬롯의 이전 활성 상태를 유지하고,
 * default.tsx는 새로고침 같은 하드 내비게이션에서만 쓰인다. 그래서 둘 다 있어야 한다.
 * 브라우저가 있어야 재현되는 결함이라 단위 테스트로는 파일 규약만 지킨다.
 */
const SLOTS = ["@topbar", "@seasonfooter"] as const;

describe("홈 병렬 슬롯", () => {
  it("슬롯마다 catch-all 페이지와 default를 함께 둔다", () => {
    for (const slot of SLOTS) {
      expect(existsSync(join(process.cwd(), "app", slot, "[...catchAll]", "page.tsx"))).toBe(true);
      expect(existsSync(join(process.cwd(), "app", slot, "default.tsx"))).toBe(true);
    }
  });

  it("메인이 아닌 경로에서는 아무것도 그리지 않는다", () => {
    expect(NoTopbarCatchAll()).toBeNull();
    expect(NoTopbarDefault()).toBeNull();
    expect(NoSeasonFooterCatchAll()).toBeNull();
    expect(NoSeasonFooterDefault()).toBeNull();
  });
});
