import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 확정본(2026-10-29-release-order.md)과 그 문서가 가리키는 런북들 — 시험이 문서 원문을 그대로 읽는다. */
export const DOCS = {
  order: "docs/operations/2026-10-29-release-order.md",
  bundle: "docs/operations/2026-10-29-pre-0143-check-bundle.md",
  runbook: "docs/operations/2026-10-29-unknown-release-runbook.md",
  relay: "docs/operations/2026-10-29-m1-relay-registry-rollout.md",
  ai2: "docs/operations/2026-10-27-ai2-stale-reconcile.md",
  text: "docs/operations/2026-10-29-text-backlog-runbook.md",
} as const;

export const read = (path: string) => readFileSync(path, "utf8");

/** `| \`경로\` (설명) | \`sha256\` |` 행만 읽는다. 스테이징 tar 행은 경로가 아니라 따로 읽는다. */
export function hashRows(doc: string): { path: string; hash: string }[] {
  return doc.split("\n").flatMap((line) => {
    const match = /^\| `([^`]+)`[^|]*\| `([0-9a-f]{64})`/.exec(line);
    return match ? [{ path: match[1], hash: match[2] }] : [];
  });
}

export function tarSha(doc: string): string | undefined {
  return doc.split("\n").map((line) => /^\| 스테이징 tar `TAR_SHA`.*\| `([0-9a-f]{64})` \|$/.exec(line)?.[1]).find(Boolean);
}

/** 문서의 `python3 -I - <첫 인자> … <<'PY'` heredoc 본문(21·22단계의 SQL 생성기). */
export function heredoc(doc: string, firstArg: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`python3 -I - "${firstArg}"`) && line.endsWith("<<'PY'"));
  if (start < 0) throw new Error(`heredoc_missing:${firstArg}`);
  const end = lines.indexOf("PY", start + 1);
  if (end < 0) throw new Error(`heredoc_unterminated:${firstArg}`);
  return lines.slice(start + 1, end).join("\n");
}

/** 문서의 생성기를 실제 런북(작업 트리)에 돌려 새 폴더에 쓴 SQL 파일을 돌려준다. */
export function generate(kind: "ai2" | "text", deployAt = "2026-10-30T01:02:03.123456789Z") {
  const order = read(DOCS.order), out = mkdtempSync(join(tmpdir(), `release-order-${kind}-`));
  const code = kind === "ai2" ? heredoc(order, "$W/post/ai2-runbook.md") : heredoc(order, "$W/post/text-runbook.md");
  const args = kind === "ai2" ? [DOCS.ai2, out] : [DOCS.text, out, deployAt];
  const result = spawnSync("python3", ["-I", "-", ...args], { input: code, encoding: "utf8" });
  const files = Object.fromEntries(readdirSync(out).sort().map((name) => [name.replace(/\.sql$/, ""), read(join(out, name))]));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, files };
}
