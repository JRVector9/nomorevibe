import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

/**
 * slug 경합 재시도 (1차·2차 리뷰에서 연달아 지적된 경로).
 *
 * nextAvailableSlug가 빈 자리를 확인한 뒤 insert하기 전에 다른 요청이 그 slug를
 * 차지하면 unique 위반이 난다. 재시도가 없으면 500이 되고, uniqueViolation이
 * DrizzleQueryError를 못 뚫으면 재시도 분기 자체가 죽은 코드가 된다.
 *
 * 진짜 동시 요청 대신, 첫 조회가 이미 사용 중인 slug를 반환하도록 만들어
 * 실제 unique 위반을 일으킨다.
 */

const fetchPage = vi.fn();
vi.mock("@/lib/net/fetch", () => ({
  fetchPage: (...a: unknown[]) => fetchPage(...a),
  safeFetch: vi.fn().mockResolvedValue(null),
  readBodyCapped: vi.fn(),
}));

const actualRepo = await vi.importActual<typeof import("@/lib/domain/products/repository")>(
  "@/lib/domain/products/repository",
);
const nextAvailableSlug = vi.fn();
vi.mock("@/lib/domain/products/repository", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/products/repository")>(
    "@/lib/domain/products/repository",
  );
  return { ...actual, nextAvailableSlug: (...a: unknown[]) => nextAvailableSlug(...a) };
});

const { registerProduct } = await import("@/lib/domain/products/register");
const { ensureSchema, resetTables } = await import("./setup");

const input = (url: string) => ({
  url,
  name: "simpleHWP",
  tagline: "브라우저에서 HWP를 여는 도구",
  description: "한글 오피스 없이 .hwp를 브라우저에서 엽니다.",
  category: "Productivity" as const,
});

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  fetchPage.mockReset().mockResolvedValue({ status: 200, html: "<html></html>" });
  nextAvailableSlug.mockReset();
});

describe("slug 경합", () => {
  it("이미 점유된 slug를 받으면 재시도해서 다른 slug로 등록한다", async () => {
    // 먼저 simplehwp를 점유
    nextAvailableSlug.mockImplementation(actualRepo.nextAvailableSlug);
    const first = await registerProduct(input("https://a.test"));
    expect(first.ok).toBe(true);

    // 두 번째 등록에서 첫 시도만 점유된 slug를 반환 → unique 위반 → 재시도
    nextAvailableSlug
      .mockResolvedValueOnce("simplehwp")
      .mockImplementation(actualRepo.nextAvailableSlug);

    const second = await registerProduct(input("https://b.test"));

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.slug).not.toBe("simplehwp");
    expect(second.value.slug).toBe("simplehwp-2");
    // 첫 시도가 실패했으므로 조회가 두 번 이상 일어났어야 한다
    expect(nextAvailableSlug.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("재시도 한도를 넘으면 500으로 던진다 (조용히 잘못된 상태를 만들지 않는다)", async () => {
    nextAvailableSlug.mockImplementation(actualRepo.nextAvailableSlug);
    await registerProduct(input("https://a.test"));

    // 계속 점유된 slug만 반환 → 한도 소진
    nextAvailableSlug.mockResolvedValue("simplehwp");
    await expect(registerProduct(input("https://b.test"))).rejects.toThrow();
  });

  it("URL이 겹치면 재시도하지 않고 duplicate로 알린다", async () => {
    nextAvailableSlug.mockImplementation(actualRepo.nextAvailableSlug);
    await registerProduct(input("https://a.test"));

    // 같은 URL — slug를 바꿔도 URL unique에 걸리므로 재시도는 무의미하다
    const dup = await registerProduct(input("https://a.test"));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatchObject({ kind: "duplicate", slug: "simplehwp" });
  });
});
