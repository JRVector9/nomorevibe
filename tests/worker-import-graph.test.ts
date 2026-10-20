import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 워커 이미지(Dockerfile worker·monitor, Oracle release)에는 lib·scripts·drizzle 만 있다. 잡 목록과 워커 진입점이 모듈을 올릴 때
 * 정적으로 닿는 파일을 따라가, 웹에만 있는 messages·app·components 나 server-only 에 닿지 않는지 본다.
 * import type 과 동적 import() 는 올릴 때 읽지 않으므로 따라가지 않는다.
 */
const ROOT = path.resolve(__dirname, "..");
const ENTRIES = [
  "lib/jobs/registry.ts",
  "scripts/worker.ts",
  "scripts/role-worker.ts",
  "scripts/worker-supervisor.ts",
  "scripts/worker-healthcheck.ts",
  "scripts/scheduler.ts",
  "scripts/worker-oracle-preflight.ts",
];
const MONITOR_ENTRIES = ["scripts/watch-failover-readiness.ts", "scripts/monitor-healthcheck.ts"];
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? path.join(ROOT, specifier.slice(2))
    : specifier.startsWith(".") ? path.resolve(path.dirname(from), specifier) : null;
  if (!base) return null;
  for (const suffix of EXTENSIONS) {
    const file = base + suffix;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  throw new Error(`unresolved ${specifier} from ${path.relative(ROOT, from)}`);
}

/** 올릴 때 읽는 import·export … from — 이름이 모두 type 인 것도 빠진다 */
function valueSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const typeOnly = clause && (clause.isTypeOnly || (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      if (!typeOnly) found.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const typeOnly = statement.isTypeOnly || (statement.exportClause && ts.isNamedExports(statement.exportClause)
        && statement.exportClause.elements.length > 0 && statement.exportClause.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) found.push(statement.moduleSpecifier.text);
    }
  }
  return found;
}

function reachable(entries: readonly string[]): { files: string[]; serverOnly: string[] } {
  const seen = new Set<string>();
  const serverOnly: string[] = [];
  const queue = entries.map((entry) => path.join(ROOT, entry));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx|mts|js|mjs)$/.test(file)) continue;
    for (const specifier of valueSpecifiers(file)) {
      if (specifier === "server-only") serverOnly.push(path.relative(ROOT, file));
      const target = resolveLocal(file, specifier);
      if (target) queue.push(target);
    }
  }
  return { files: [...seen].map((file) => path.relative(ROOT, file)).sort(), serverOnly };
}

/** Oracle native release 에 담는 맨 앞 이름(deploy/oracle/release_contract.py 의 ROOTS·ROOT_FILES) */
function oracleRoots(): Set<string> {
  const contract = readFileSync(path.join(ROOT, "deploy/oracle/release_contract.py"), "utf8");
  const set = (name: string) => [...(new RegExp(`^${name} = \\{([^}]*)\\}`, "m").exec(contract)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return new Set([...set("ROOTS"), ...set("ROOT_FILES")]);
}

/** Dockerfile 한 단계가 복사하는 저장소 안 경로(맨 앞 이름) */
function copiedRoots(stageName: string): Set<string> {
  const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const block = dockerfile.split(/^(?=FROM )/m).find((row) => new RegExp(`^FROM \\S+ AS ${stageName}\\n`).test(row));
  if (!block) throw new Error(`missing stage ${stageName}`);
  const roots = new Set<string>();
  for (const line of block.split("\n").filter((row) => row.startsWith("COPY ") && !row.includes("--from="))) {
    const parts = line.split(/\s+/).slice(1).filter((part) => !part.startsWith("--"));
    for (const source of parts.slice(0, -1)) roots.add(source.split("/")[0]);
  }
  return roots;
}

const FORBIDDEN = /^(messages|app|components)\//;

describe("워커 이미지 import 그래프", () => {
  it("잡 목록·워커 진입점은 messages·app·components·server-only 에 정적으로 닿지 않는다", () => {
    const { files, serverOnly } = reachable(ENTRIES);
    expect(files).toContain("lib/jobs/me/email.ts");
    expect(files).toContain("lib/me/email-outbox.ts");
    expect(files.filter((file) => FORBIDDEN.test(file))).toEqual([]);
    expect(serverOnly).toEqual([]);
  });

  it("닿는 파일은 모두 worker 단계와 Oracle release 가 담는 곳에 있다", () => {
    const { files } = reachable(ENTRIES);
    for (const roots of [copiedRoots("worker"), oracleRoots()]) {
      expect(roots).toContain("lib");
      expect(files.filter((file) => !roots.has(file.split("/")[0]))).toEqual([]);
    }
  });

  it("monitor 단계 진입점도 그 단계가 복사한 곳 안에서 끝난다", () => {
    const roots = copiedRoots("monitor");
    const { files, serverOnly } = reachable(MONITOR_ENTRIES);
    expect(files.filter((file) => FORBIDDEN.test(file) || !roots.has(file.split("/")[0]))).toEqual([]);
    expect(serverOnly).toEqual([]);
  });

  it("worker 단계는 메일 글을 늦게 읽도록 messages 를 함께 담는다", () => {
    expect(copiedRoots("worker")).toContain("messages");
  });
});
