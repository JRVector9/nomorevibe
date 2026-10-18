import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), headerList: vi.fn(), set: vi.fn(), fence: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/operations/dr/epoch", async original => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(), readWriterFence: mocks.fence }));
vi.mock("@/lib/auth/admin", async () => {
  const { adminOrigin } = await import("@/lib/auth/admin-access");
  return { currentAdmin: mocks.admin, adminOrigin, authSecret: () => "a".repeat(32), adminLocalLoginEnabled: () => false, LOCAL_ADMIN_LOGIN: "local" };
});
vi.mock("@/lib/crawl/settings", () => ({ setSourceBufferEnabled: mocks.set }));
vi.mock("next/headers", () => ({ headers: mocks.headerList }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));

const ADMIN = { login: "jr", exp: Math.floor(Date.now() / 1000) + 3600 };
const token = (login = ADMIN.login, exp = ADMIN.exp) => createHmac("sha256", "a".repeat(32)).update(`source-buffer-admin:${login}:${exp}`).digest("hex");
const input = (extra: Record<string, unknown> = {}) => ({ enabled: true, expectedEnabled: false, reason: "후단 적체 시험", csrfToken: token(),
  csrfExpiresAt: ADMIN.exp, ...extra }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.example");
  vi.stubEnv("ADMIN_ORIGIN", "https://admin.nomorevibe.example");
  mocks.admin.mockResolvedValue(ADMIN);
  mocks.headerList.mockResolvedValue(new Headers({ origin: "https://admin.nomorevibe.example" }));
  mocks.fence.mockResolvedValue({ state: "active" });
  mocks.set.mockResolvedValue({ ok: true });
});
const action = async () => (await import("@/app/(operator)/admin/status/source-buffer-actions")).setSourceBufferAction;

/**
 * 원본 공급 조절 켜기·끄기(ops-v8 PR8)는 다른 관리자 쓰기와 같은 문을 지난다 — 재해 복구 쓰기 관문, 관리자 세션,
 * 요청 확인(관리자 주소·세션 HMAC), 그다음에야 잠근 행의 compare-and-set(lib/crawl/settings.ts).
 */
describe("원본 공급 조절 스위치 액션", () => {
  it("관리자 세션이 없으면 아무것도 바꾸지 않는다", async () => {
    mocks.admin.mockResolvedValue(null);
    expect(await (await action())(input())).toEqual({ error: "관리자 로그인이 필요합니다." });
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("요청 확인 값·관리자 주소·세션 만료가 맞아야 한다", async () => {
    const run = await action();
    expect((await run(input({ csrfToken: "0".repeat(64) }))).error).toContain("요청을 확인하지 못했습니다");
    expect((await run(input({ csrfToken: token("someone") }))).error).toContain("요청을 확인하지 못했습니다");
    expect((await run(input({ csrfExpiresAt: ADMIN.exp - 1, csrfToken: token(ADMIN.login, ADMIN.exp - 1) }))).error).toContain("요청을 확인하지 못했습니다");
    mocks.headerList.mockResolvedValue(new Headers({ origin: "https://nomorevibe.example" }));
    expect((await run(input())).error).toContain("요청을 확인하지 못했습니다");
    mocks.headerList.mockResolvedValue(new Headers({ origin: "https://attacker.example" }));
    expect((await run(input())).error).toContain("요청을 확인하지 못했습니다");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("바꿀 값은 화면이 본 값의 반대여야 하고 사유가 있어야 한다", async () => {
    const run = await action();
    expect(await run(input({ expectedEnabled: true }))).toEqual({ error: "바꿀 값을 확인해 주세요." });
    expect(await run(input({ enabled: "true" }))).toEqual({ error: "바꿀 값을 확인해 주세요." });
    expect(await run(input({ reason: "   " }))).toEqual({ error: "사유를 적어 주세요." });
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("통과하면 잠근 행의 compare-and-set 으로 넘기고 운영센터를 다시 그린다", async () => {
    const result = await (await action())(input({ reason: "  후단 적체 시험  " }));
    expect(mocks.set).toHaveBeenCalledWith({ enabled: true, expectedEnabled: false, actor: "jr", reason: "후단 적체 시험" });
    expect(result.message).toContain("켰습니다");
    expect(mocks.revalidate).toHaveBeenCalledWith("/admin/status");
  });

  it("그 사이 바뀌었으면 거절 사유를 그대로 돌려준다", async () => {
    mocks.set.mockResolvedValue({ ok: false, issues: ["그 사이 다른 곳에서 바뀌었습니다."] });
    expect(await (await action())(input())).toEqual({ error: "그 사이 다른 곳에서 바뀌었습니다." });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("fenced DB(재해 복구 쓰기 잠금)에 붙은 웹은 쓰기 전에 거절한다", async () => {
    mocks.fence.mockResolvedValue({ state: "fenced" });
    await expect((await action())(input())).rejects.toThrow();
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
