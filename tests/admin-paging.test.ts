import { describe, expect, it } from "vitest";
import { pageWindow } from "@/app/admin/paging";

describe("쪽 번호 줄", () => {
  it("쪽이 적으면 모두 보인다", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
  });

  it("처음·끝과 지금 쪽 앞뒤 둘만 두고 사이는 줄인다", () => {
    expect(pageWindow(7, 14)).toEqual([1, null, 5, 6, 7, 8, 9, null, 14]);
    expect(pageWindow(1, 14)).toEqual([1, 2, 3, null, 14]);
    expect(pageWindow(14, 14)).toEqual([1, null, 12, 13, 14]);
  });

  it("바로 붙은 쪽 사이에는 줄임표를 넣지 않는다", () => {
    expect(pageWindow(4, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
