import { expect, it } from "vitest";
import { parseOpsSubmitArgs } from "@/scripts/ops/admin-models-ops-submit";

const ok = ["--target=65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7", "--id=ad2b84de-4ddf-4b2e-9dbd-605c64f7d728", "--operator=jr", "--reason=Supa 65f8c399 release (release-order)"];
it("운영자 셸 접수는 요청 해제 한 종류만 받고 기본은 미리 보기다", () => {
  expect(parseOpsSubmitArgs(ok)).toEqual({ operator: "jr", execute: false, command: { action: "request-release",
    targetId: "65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7", id: "ad2b84de-4ddf-4b2e-9dbd-605c64f7d728", reason: "Supa 65f8c399 release (release-order)", confirmed: true } });
  expect(parseOpsSubmitArgs([...ok, "--execute"]).execute).toBe(true);
});
it("다른 동작·누락·중복·명령 주입·제어 문자·잘못된 ID를 거절한다", () => {
  for (const args of [ok.slice(1), [...ok, "--action=admission-open"], [...ok, ok[0]], [...ok, "--execute", "--execute"],
    [ok[0], ok[1], "--operator=jr;sudo", ok[3]], [ok[0], ok[1], ok[2], "--reason=a\nb"], ["--target=model-capacity", ok[1], ok[2], ok[3]],
    [ok[0], "--id=not-a-uuid", ok[2], ok[3]], [...ok, "--apply"]])
    expect(() => parseOpsSubmitArgs(args)).toThrow("ops_submit_arguments_denied");
});
