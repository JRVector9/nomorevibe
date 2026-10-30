import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), connect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/operations/admin-engine-connect", async importOriginal =>
  ({ ...await importOriginal<typeof import("@/lib/operations/admin-engine-connect")>(), connectAdminEngine: mocks.connect }));
import { connectEngine } from "@/app/(operator)/admin/models/contracts/actions";

const form = (fields: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) for (const row of [value].flat()) data.append(name, row);
  return data;
};
const base = { registryKey: "m1:translation", baseUrl: "https://m1.tail0.ts.net/v1", auth: "none", engineModel: "gemma", routes: ["product-translate"], selectStages: "on" };
const connected = { registryId: 1, contracts: [{ routeId: "product-translate", id: 2 }], stages: ["product-translate"], requestModel: "gemma", responseModel: "gemma",
  firstReviewRenamed: false, missingPolicyRoutes: [], totalTokenBound: 131072, totalTokenBoundFrom: "operator" };
beforeEach(() => { vi.resetAllMocks(); mocks.admin.mockResolvedValue({ login: "jr" }); mocks.connect.mockResolvedValue(connected); });

it("컨텍스트 상한: 비우면 없음, 숫자면 정수로 넘기고 결과에 운영자 입력을 표시, 숫자가 아니면 엔진을 부르기 전에 거절", async () => {
  expect(await connectEngine(null, form(base))).toMatchObject({ ok: true });
  expect(mocks.connect).toHaveBeenLastCalledWith(expect.objectContaining({ maxModelLen: undefined, auth: "none", routes: ["product-translate"], selectStages: true }), "jr");
  expect(await connectEngine(null, form({ ...base, maxModelLen: " 131072 " }))).toMatchObject({ ok: true, message: expect.stringContaining("토큰 한도 131072(운영자 입력)") });
  expect(mocks.connect.mock.lastCall?.[0]).toMatchObject({ maxModelLen: 131072 });
  mocks.connect.mockResolvedValueOnce({ ...connected, totalTokenBound: 98304, totalTokenBoundFrom: "engine" });
  expect(await connectEngine(null, form({ ...base, maxModelLen: "98304" }))).toMatchObject({ message: expect.stringContaining("토큰 한도 98304.") });
  for (const bad of ["abc", "1.5", "1e5", "-1", "12345678"])
    expect(await connectEngine(null, form({ ...base, maxModelLen: bad }))).toEqual({ issues: [expect.stringContaining("2,097,152")] });
  expect(mocks.connect).toHaveBeenCalledTimes(3);
});

it("엔진 쪽 거절은 운영자가 할 일이 보이는 문장으로 바꾼다 (상한 입력 요청, 두 값의 불일치, 범위 밖)", async () => {
  mocks.connect.mockRejectedValueOnce(new Error("engine_max_len_unknown"));
  expect(await connectEngine(null, form(base))).toEqual({ issues: [expect.stringContaining("「컨텍스트 상한(토큰)」")] });
  mocks.connect.mockRejectedValueOnce(new Error("engine_max_len_mismatch:98304:131072"));
  const mismatch = (await connectEngine(null, form({ ...base, maxModelLen: "131072" })))?.issues?.[0] ?? "";
  expect(mismatch).toContain("(98304)"); expect(mismatch).toContain("(131072)"); expect(mismatch).toContain("엔진 값이 기준");
  mocks.connect.mockRejectedValueOnce(new Error("engine_max_len_invalid"));
  expect(await connectEngine(null, form({ ...base, maxModelLen: "0" }))).toEqual({ issues: [expect.stringContaining("2,097,152")] });
  mocks.connect.mockRejectedValueOnce(new Error("secret-key-value"));
  expect(JSON.stringify(await connectEngine(null, form(base)))).not.toContain("secret-key-value");
  mocks.admin.mockResolvedValueOnce(null);
  expect(await connectEngine(null, form(base))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
  expect(mocks.connect).toHaveBeenCalledTimes(4);
});
