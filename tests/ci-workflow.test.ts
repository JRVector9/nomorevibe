import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * 필수 `check` 와 배포 스크립트가 기대는 CI 모양을 지킨다.
 * - check 는 검사 잡을 하나도 빠뜨리지 않고 기다린다(새 검사 잡을 needs 에 안 넣으면 깨진다).
 * - 배포 스크립트는 `publish-*-image` 잡 로그에서 처음 나오는 `DIGEST: sha256:` 한 줄을 배포 digest 로 읽는다.
 */
type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, string> };
type Job = { needs?: string | string[]; if?: string; steps: Step[]; strategy?: { matrix?: { shard?: number[] } } };
const workflow = parse(readFileSync(path.join(__dirname, "..", ".github/workflows/ci.yml"), "utf8")) as {
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<string, Job>;
};
const jobs = workflow.jobs;
const needs = (job: Job) => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []);

describe("CI 워크플로", () => {
  it("검사를 돌리는 잡은 모두 check 가 기다리고, check 는 scope 의 판단(run_tests)으로 결과를 본다", () => {
    const gated = Object.entries(jobs)
      .filter(([, job]) => job.if?.includes("needs.scope.outputs.run_tests == 'true'"))
      .map(([name]) => name).sort();
    expect(gated).toEqual(["build", "integration", "integration-ledger", "lint", "typecheck", "unit"]);
    expect(needs(jobs.check).sort()).toEqual(["scope", ...gated].sort());
    expect(jobs.check.if).toBe("always()");
    const verdict = jobs.check.steps[0];
    for (const name of gated) expect(verdict.env?.TEST_RESULTS).toContain(`needs.${name}.result`);
    expect(verdict.run).toContain("true/false) [[ \"$REUSED_RUN\" =~ ^[0-9]+$ ]]; expected=skipped");
  });

  it("검사한 트리 기록은 같은 저장소 PR 이 검사를 다 통과했을 때만 남긴다", () => {
    const record = jobs.check.steps.filter((step) => step.if?.includes("github.event_name == 'pull_request'"));
    expect(record).toHaveLength(2);
    for (const step of record) {
      expect(step.if).toContain("success()");
      expect(step.if).toContain("needs.scope.outputs.run_tests == 'true'");
      expect(step.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    }
    expect(record[1].uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
  });

  it("PR 만 이전 실행을 취소하고 main push 는 실행마다 따로 돈다", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
    expect(workflow.concurrency.group).toContain("github.run_id");
  });

  it("통합 묶음 수와 --shard 분모가 같다", () => {
    const shards = jobs.integration.strategy?.matrix?.shard ?? [];
    const run = jobs.integration.steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain(`--shard="$SHARD/${shards.length}"`);
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, index) => index + 1));
  });

  it("이미지 잡은 이름을 지키고, 로그의 DIGEST 줄은 기록 단계 하나뿐이다", () => {
    for (const name of ["publish-worker-image", "publish-web-image"]) {
      const job = jobs[name];
      expect(needs(job)).toEqual(["scope", "check"]);
      expect(job.if).toContain("needs.check.result == 'success'");
      const digestKeys = job.steps.flatMap((step) => Object.keys(step.env ?? {}).filter((key) => /DIGEST$/.test(key)));
      expect(digestKeys).toEqual(["DIGEST"]);
      const record = job.steps.find((step) => step.env?.DIGEST);
      expect(record?.name).toMatch(/^Record (worker|web) digest$/);
      expect(record?.run).toContain("[[ \"$DIGEST\" =~ ^sha256:[a-f0-9]{64}$ ]]");
    }
  });

  it("Actions 는 고정 SHA 로 쓴다", () => {
    for (const job of Object.values(jobs)) {
      for (const step of job.steps) {
        if (step.uses && !step.uses.startsWith("./")) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});
