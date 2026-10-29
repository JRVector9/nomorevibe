import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("Supa 65f8c399 manifest 생성기는 adapter의 identity 계산과 같고 manifest·profile·검토 소스 해시를 서로 묶는다", () => {
  const result = execFileSync("/usr/bin/python3", ["-I", "-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test_release_65f8c399_manifest.py"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  expect(result).toBe("");
});
