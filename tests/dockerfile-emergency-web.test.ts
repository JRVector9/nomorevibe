import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 비상 최소 웹/관리자 이미지(PR16)를 빌드 없이 정적으로 본다. 기존 target 과 기본 target(runner)은 그대로여야 하고,
 * 새 target 은 runner 와 같은 builder 산출물(같은 deploymentId·서버 액션 키)만 담는다 — 수집기·CLI·job handler 는 없다.
 */
const dockerfile = readFileSync(path.join(path.resolve(__dirname, ".."), "Dockerfile"), "utf8");
const stages = dockerfile.split(/^(?=FROM )/m).filter((block) => block.startsWith("FROM ")).map((block) => {
  const [, base, name] = /^FROM (\S+) AS (\S+)\n/.exec(block) ?? [];
  return { base, name, block };
});
const stage = (name: string) => stages.find((row) => row.name === name)!;

describe("Dockerfile 비상 최소 웹 target", () => {
  it("기존 target 이름·순서를 지키고 기본 target 은 여전히 runner 다", () => {
    expect(stages.map((row) => row.name)).toEqual(["deps", "worker-deps", "builder", "worker", "connect-agent", "monitor", "emergency-web", "runner"]);
    expect(stages.at(-1)?.name).toBe("runner");
  });

  it("runner 와 같은 builder 산출물만 복사하고 설치·빌드 비밀·작업 코드는 없다", () => {
    const { base, block } = stage("emergency-web");
    expect(base).toBe("node:24-alpine");
    const copies = block.split("\n").filter((line) => line.startsWith("COPY"));
    expect(copies).toEqual([
      "COPY --from=builder --chown=nextjs:nodejs /app/public ./public",
      "COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./",
      "COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static",
    ]);
    expect(copies.filter((line) => stage("runner").block.includes(line))).toEqual(copies);
    for (const forbidden of ["npm ", "curl", "--mount=type=secret", "worker-deps", "claude", "codex", "grok", "scripts/", "lib "]) {
      expect(block).not.toContain(forbidden);
    }
  });

  it("root 가 아닌 사용자로 server.js 를 tini 아래 돌리고, 자기 health 를 loopback 으로 묻는다", () => {
    const { block } = stage("emergency-web");
    const lines = block.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(lines).toContain("USER nextjs");
    expect(lines.indexOf("USER nextjs")).toBeLessThan(lines.findIndex((line) => line.startsWith("CMD")));
    expect(lines).toContain("ENV HOSTNAME=0.0.0.0");
    expect(lines).toContain('ENTRYPOINT ["/sbin/tini", "--"]');
    expect(lines.at(-1)).toBe('CMD ["node", "server.js"]');
    expect(block).toMatch(/HEALTHCHECK [^\n]*\\\n\s+CMD node -e "fetch\('http:\/\/127\.0\.0\.1:3000\/api\/health'/);
  });
});
