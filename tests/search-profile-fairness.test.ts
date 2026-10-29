import { describe, expect, it } from "vitest";
import { interleaveProfileTasks } from "@/lib/domain/products/search-profiles";

const tasks = (...ids: number[]) => ids.map(id => ({ product: { id } }));
const ids = (rows: { product: { id: number } }[]) => rows.map(row => row.product.id);

describe("interleaveProfileTasks — 오래 기다린 줄과 우선순위 줄을 섞는다", () => {
  it("우선순위 둘, 오래 기다린 것 하나 순으로 놓는다", () => {
    expect(ids(interleaveProfileTasks(tasks(1, 2, 3, 4), tasks(10, 11, 12, 13, 14, 15, 16, 17), 12)))
      .toEqual([10, 11, 1, 12, 13, 2, 14, 15, 3, 16, 17, 4]);
    // 한 건만 고를 때는 우선순위 줄의 머리다
    expect(ids(interleaveProfileTasks(tasks(1), tasks(10), 1))).toEqual([10]);
  });
  it("겹치는 제품은 한 번만 넣고 모자란 자리는 다른 줄로 채운다", () => {
    expect(ids(interleaveProfileTasks(tasks(1, 2), tasks(10, 11, 12), 12))).toEqual([10, 11, 1, 12, 2]);
    expect(ids(interleaveProfileTasks(tasks(11, 2), tasks(10, 11, 12), 12))).toEqual([10, 11, 12, 2]);
    expect(ids(interleaveProfileTasks(tasks(), tasks(10, 11), 12))).toEqual([10, 11]);
    expect(ids(interleaveProfileTasks(tasks(1, 2, 3), tasks(), 12))).toEqual([1, 2, 3]);
  });
  it("한도를 넘지 않는다", () => {
    expect(ids(interleaveProfileTasks(tasks(1, 2, 3, 4, 5), tasks(10, 11, 12, 13, 14, 15, 16, 17, 18, 19), 4))).toEqual([10, 11, 1, 12]);
  });
});
