import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("root handoff의 실제 Python 검증기는 소유권·binding·live 종료·재전송 금지를 검증한다", () => {
  const result = execFileSync("/usr/bin/python3", ["-I", "-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test_systemd_root_handoff.py"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  expect(result).toBe("");
});
