import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { findTestedRun } from "@/scripts/ci-reuse.mjs";

/**
 * 필수 `check` 와 배포 스크립트가 기대는 CI 모양을 지킨다.
 * - check 는 검사 잡을 하나도 빠뜨리지 않고 기다린다(새 검사 잡을 needs 에 안 넣으면 깨진다).
 * - 배포 스크립트는 `publish-*-image` 잡 로그에서 처음 나오는 `DIGEST: sha256:` 한 줄을 배포 digest 로 읽는다.
 */
type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>;
  with?: Record<string, string | boolean>; "continue-on-error"?: boolean };
type Job = { needs?: string | string[]; if?: string; steps: Step[]; strategy?: { matrix?: { shard?: number[] } } };
const workflow = parse(readFileSync(path.join(__dirname, "..", ".github/workflows/ci.yml"), "utf8")) as {
  on: { pull_request: { types: string[] } };
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
    const verdict = jobs.check.steps.find((step) => step.name === "Required branch-protection result")!;
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
      // 재사용한 main 실행은 검사 잡이 skipped 다 — 상태 함수가 없으면 암묵 success() 로 이미지 잡도 건너뛴다
      expect(job.if).toMatch(/^!cancelled\(\) &&/);
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

  it("draft PR 은 검사를 돌리지 않고 check 만 실패한다 — ready for review 로 바꾸면 전체 검사가 돈다", () => {
    // draft 로 되돌려도 다시 돌아 실패하는 check 가 예전 초록 check 를 대신한다
    expect(workflow.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"]);
    expect(jobs.scope.if).toBe("github.event.pull_request.draft != true");
    // scope 를 건너뛰면 따라서 건너뛰도록: check 말고는 모두 scope 를 기다리고, always() 로 건너뛰기를 무시하지 않는다
    // 이미지 잡만 !cancelled() 를 쓴다 — main push 이고 check 가 success 일 때만이라 draft 에서는 여전히 돌지 않는다
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "scope" || name === "check") continue;
      expect(needs(job), name).toContain("scope");
      const condition = name.startsWith("publish-") ? (job.if ?? "").replace(/^!cancelled\(\) &&/, "") : job.if ?? "";
      expect(condition, name).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
    }
    // check 는 draft 에서도 돈다(if: always()) — 첫 단계가 실패해 초록 check 를 남기지 않고, 뒤 단계(트리 기록)는 돌지 않는다
    expect(jobs.check.if).toBe("always()");
    const [draft, ...rest] = jobs.check.steps;
    expect(draft.if).toBe("github.event.pull_request.draft == true");
    expect(draft.run).toContain("draft PR — CI not run; mark ready for review");
    expect(draft.run).toContain("exit 1");
    for (const step of rest) expect(step.if ?? "").not.toMatch(/always\(\)|failure\(\)/);
  });

  it("main 재사용은 check 가 실패한 실행(draft 실행 포함)을 근거로 쓰지 않는다", async () => {
    const repo = "JRVector9/nomorevibe", sha = "a".repeat(40), tree = "b".repeat(40), head = "c".repeat(40);
    const api = (checkConclusion: string) => async (url: string) => {
      if (url.endsWith(`/commits/${sha}/pulls`)) return [{ number: 1, merge_commit_sha: sha, merged_at: "2026-10-22T00:00:00Z",
        base: { ref: "main", repo: { full_name: repo } }, head: { sha: head, repo: { full_name: repo } } }];
      if (url.includes("/actions/artifacts?name=")) return { artifacts: [{ name: `ci-tested-tree-${tree}`, expired: false,
        workflow_run: { id: 7, head_sha: head, head_repository_id: 1, repository_id: 1 } }] };
      if (url.endsWith("/actions/runs/7")) return { id: 7, event: "pull_request", path: ".github/workflows/ci.yml", head_sha: head,
        repository: { full_name: repo }, head_repository: { full_name: repo } };
      if (url.includes("/actions/runs/7/jobs")) return { jobs: [{ name: "check", status: "completed", conclusion: checkConclusion }] };
      throw new Error(url);
    };
    const sleep = async () => {};
    expect(await findTestedRun({ repo, sha, tree, api: api("failure"), sleep })).toEqual({ reason: "tested_run_not_successful" });
    expect(await findTestedRun({ repo, sha, tree, api: api("success"), sleep })).toMatchObject({ runId: 7, prNumber: 1 });
  });

  it("같은 저장소 PR 은 검사와 나란히 트리 태그 이미지를 만들고, check 는 그것을 기다리지 않는다", () => {
    for (const [name, repository] of [["pr-image-worker", "nomorevibe-worker"], ["pr-image-web", "nomorevibe-runtime-web"]]) {
      const job = jobs[name];
      expect(needs(job)).toEqual(["scope"]);
      expect(needs(jobs.check)).not.toContain(name);
      expect(job.if).toContain("github.event_name == 'pull_request'");
      expect(job.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
      const build = job.steps.find((step) => step.uses?.startsWith("docker/build-push-action@"));
      expect(build?.with?.tags).toBe(`ghcr.io/jrvector9/${repository}:tree-\${{ needs.scope.outputs.tree }}`);
      expect(build?.with?.provenance).toBe(false);
      expect(String(build?.with?.labels)).toContain("dev.nomorevibe.tree=${{ needs.scope.outputs.tree }}");
      expect(job.steps.at(-1)?.run).toBe(`scripts/ci-promote-image.sh --check ghcr.io/jrvector9/${repository} "$TREE"`);
    }
  });

  it("main 은 같은 트리의 PR 이미지를 승격하고, 안 되면 소스에서 빌드한다", () => {
    for (const [name, repository] of [["publish-worker-image", "nomorevibe-worker"], ["publish-web-image", "nomorevibe-runtime-web"]]) {
      const steps = jobs[name].steps;
      const promote = steps.find((step) => step.id === "promote");
      expect(promote?.if).toBe("github.event_name == 'push'");
      expect(promote?.["continue-on-error"]).toBe(true);
      expect(promote?.run).toBe(`scripts/ci-promote-image.sh ghcr.io/jrvector9/${repository} "$TREE" "$GITHUB_SHA"`);
      const build = steps.find((step) => step.id === "build");
      expect(build?.if).toBe("steps.promote.outputs.digest == ''");
      expect(build?.with?.tags).toBe(`ghcr.io/jrvector9/${repository}:\${{ github.sha }}`);
      expect(steps.find((step) => step.env?.DIGEST)?.env?.DIGEST).toBe("${{ steps.promote.outputs.digest || steps.build.outputs.digest }}");
    }
  });
});
