import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, generate, hashRows, read, tarSha } from "./release-order-doc";

// 확정본 표 3·사전 점검 묶음 0절·실행서 표 0·relay 안내 표의 SHA-256은 대표가 그대로 대조하는 값이다.
// 이 시험이 실패하면 코드가 문서의 REL 이후 바뀐 것이다. 확정본을 새 main 기준으로 다시 계산해 갱신한다(확정본 3절 「배포 TARGET」).
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const resolve = (path: string) => existsSync(path) ? path : `scripts/ops/${path}`;
const docs = { order: read(DOCS.order), bundle: read(DOCS.bundle), runbook: read(DOCS.runbook), relay: read(DOCS.relay) };
const STAGED = ["lib", "scripts", "drizzle", "messages", "tsconfig.json", "package.json", "package-lock.json"];

describe("확정본 해시 표", () => {
  it.each(Object.entries(docs))("%s 표의 파일 해시가 작업 트리 파일과 같다", (_name, doc) => {
    const rows = hashRows(doc);
    expect(rows.length).toBeGreaterThan(0);
    const mismatched = rows.filter((row) => !existsSync(resolve(row.path)) || sha(readFileSync(resolve(row.path))) !== row.hash);
    expect(mismatched).toEqual([]);
  });

  it("표 3은 TAR_SHA·lock·relay·배포 뒤 도구를 담고, 같은 파일은 네 문서에서 같은 값이다", () => {
    const order = hashRows(docs.order).map((row) => row.path);
    for (const path of ["package-lock.json", "scripts/ops/release-order/capacity-control.sh", "scripts/local-model-relay/server.ts",
      "scripts/local-model-relay/config.ts", "scripts/reconcile-ai2-stale.ts", "scripts/check-worker-progress.ts"]) expect(order).toContain(path);
    const seen = new Map<string, string>();
    for (const doc of Object.values(docs)) for (const row of hashRows(doc)) {
      expect(seen.get(row.path) ?? row.hash, row.path).toBe(row.hash);
      seen.set(row.path, row.hash);
    }
    expect(tarSha(docs.order)).toMatch(/^[0-9a-f]{64}$/);
    expect(tarSha(docs.bundle)).toBe(tarSha(docs.order));
  });

  it("REL·RELAY_SHA는 확정본·묶음·실행서·relay 안내에서 같은 값이다", () => {
    const rel = /\*\*`REL=([0-9a-f]{40})`\*\*/.exec(docs.order)?.[1];
    expect(rel).toMatch(/^[0-9a-f]{40}$/);
    const others = [...docs.bundle.matchAll(/^REL=([0-9a-f]{40})$/gm), ...docs.runbook.matchAll(/(?<![A-Z_])(?:SHA|REL)=([0-9a-f]{40})(?![0-9a-f])/g)].map((m) => m[1]);
    expect(others.length).toBeGreaterThanOrEqual(4);
    expect(new Set(others)).toEqual(new Set([rel]));
    expect(docs.bundle).toContain(`기준 SHA는 PR #735 병합 main \`${rel}\``);
    const relay = /\*\*`RELAY_SHA=([0-9a-f]{40})`\*\*/.exec(docs.order)?.[1];
    expect(docs.relay).toContain(`relay 설치본 SHA는 \`${relay}\``);
    expect(docs.order).toContain(`/var/tmp/nmv-relay-reviewed/${relay}`);
    expect(docs.order).toContain(`/usr/local/nmv-llm-relay/releases/${relay}`);
    // 배포 TARGET은 고정하지 않는다(main 머리여야 plan·run이 main_sha_mismatch로 멈추지 않는다).
    expect(docs.order).not.toMatch(/TARGET=[0-9a-f]{40}/);
  });

  // 단위 CI는 얕은 checkout이라 REL 커밋이 없다. 전체 이력이 있는 checkout(대표 셸·작업 공간)에서만 tar를 다시 만든다.
  const rel = /\*\*`REL=([0-9a-f]{40})`\*\*/.exec(docs.order)?.[1] ?? "";
  const hasRel = spawnSync("git", ["cat-file", "-e", `${rel}^{commit}`]).status === 0;
  it.runIf(hasRel)("REL에서 git archive로 만든 스테이징 tar의 sha256이 표 3 값과 같다", () => {
    const tar = spawnSync("git", ["archive", "--format=tar", rel, ...STAGED], { maxBuffer: 1 << 30 });
    expect(tar.status).toBe(0);
    expect(sha(tar.stdout)).toBe(tarSha(docs.order));
  });
});

describe("배포 뒤 SQL 생성기 (21·22단계)", () => {
  it("21단계: AI2 런북의 Q1~Q5를 그대로 A1~A5로 뽑는다", () => {
    const { status, stdout, files } = generate("ai2");
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("ai2_sql 5");
    expect(Object.keys(files)).toEqual(["A1", "A2", "A3", "A4", "A5"]);
    expect(files.A1).toContain("WHERE s.candidate_id = 357316");
    expect(files.A5).toContain("action = 'reconcile-ai2-stale'");
    for (const body of Object.values(files)) expect(read(DOCS.ai2)).toContain(body.trimEnd());
  });

  it("22단계: 텍스트 런북 Q0~Q9를 deploy_at 리터럴로 바꿔 T0~T9로 뽑는다(psql 변수 없음)", () => {
    const at = "2026-10-30T01:02:03.123456789Z";
    const { status, stdout, files } = generate("text", at);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(`text_sql 10 deploy_at ${at}`);
    expect(Object.keys(files)).toEqual(["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"]);
    for (const body of Object.values(files)) {
      expect(body).not.toMatch(/:'[A-Za-z_]\w*'|\\set|BEGIN|ROLLBACK/);
    }
    for (const n of ["T2", "T4", "T5", "T7"]) expect(files[n]).toContain(`'${at}'::timestamptz`);
    expect(files.T0).toContain("logical_member_keys IS NULL");
    expect(files.T8).toContain("HAVING count(*) > 1");
  });

  it("22단계: docker StartedAt(UTC) 형식이 아닌 시각은 아무것도 쓰지 않고 거절한다", () => {
    for (const bad of ["2026-10-30 01:00:00+00", "2026-10-30T10:00:00+09:00", "", "2026-10-30T01:00:00Z'; DROP TABLE x; --"]) {
      const { status, stderr, files } = generate("text", bad);
      expect(status).not.toBe(0);
      expect(stderr).toContain("deploy_at_must_be_docker_startedat_utc");
      expect(files).toEqual({});
    }
  });
});
