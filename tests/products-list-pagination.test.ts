import { expect, it } from 'vitest';

/**
 * 목록만 주면 "상한에 걸린 것"과 "그게 전부인 것"을 구분할 수 없다.
 * 실제로 제품이 2,986개인데 100개만 보이고 뒤로 갈 길이 없었다.
 */
const PAGE_SIZE = 100;
const range = (total: number, page: number) => {
  const offset = (page - 1) * PAGE_SIZE;
  const shown = Math.max(0, Math.min(PAGE_SIZE, total - offset));
  return { offset, shown, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
};

it('마지막 쪽은 남은 만큼만 보여준다', () => {
  expect(range(2986, 1)).toEqual({ offset: 0, shown: 100, pages: 30 });
  expect(range(2986, 30)).toEqual({ offset: 2900, shown: 86, pages: 30 });
});

it('한 쪽에 다 들어가면 쪽 이동이 필요 없다', () => {
  expect(range(34, 1)).toEqual({ offset: 0, shown: 34, pages: 1 });
  expect(range(0, 1)).toEqual({ offset: 0, shown: 0, pages: 1 });
});

it('범위를 넘는 쪽은 빈 목록이 된다 — 500이 아니라', () => {
  expect(range(2986, 99).shown).toBe(0);
});
