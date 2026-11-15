import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DEFAULT_MODEL_CAPACITY_LEDGER_RETENTION_DAYS, ledgerRetentionDaysFromStored, readModelCapacityLedgerRetentionDays } from "@/lib/llm/capacity-retention";
import { RUNTIME_SETTING_LABELS, resolveRuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { buildSettingsControl, LEDGER_RETENTION_CONTROL, runtimeSettingsIssueMessage, runtimeSettingsPatchFromForm } from "@/lib/operations/admin-runtime-settings";
import { ledgerCandidatesSql, REPO_META_KEEP_KEYS, REPO_META_OWNER_KEEP_KEYS, shrunkRepoMetaSql } from "@/lib/operations/db-retention";
import { PACKAGE_PROOF_KEY } from "@/lib/crawl/package-proof";
import { DB_RETENTION_PART_SLICE_MS, partSliceMs } from "@/lib/jobs/db-retention";
import { factsFromRepoMeta, judgeRevision } from "@/lib/crawl/rules";
import { spamSignals } from "@/lib/crawl/spam-signals";
import { starAutoApproval } from "@/lib/crawl/star-auto-approval";
import { taglineEvidence } from "@/lib/crawl/tagline";
import { parseRepositoryStats } from "@/lib/domain/products/stars";

// DB 보관 정리(2026-11-15 ④⑤⑥)의 순수 부분 — DB 판정은 tests/integration/db-retention.test.ts.
const render = (query: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(query);

describe("모델 장부 보관 일수(capacity.ledgerRetentionDays)", () => {
  it("기본 14일, 8~90 정수만 받고 나머지는 기본값", () => {
    expect(DEFAULT_MODEL_CAPACITY_LEDGER_RETENTION_DAYS).toBe(14);
    expect(ledgerRetentionDaysFromStored(undefined)).toBe(14);
    expect(ledgerRetentionDaysFromStored(8)).toBe(8);
    expect(ledgerRetentionDaysFromStored(90)).toBe(90);
    for (const bad of [7, 0, 91, 14.5, "14", null, true]) expect(ledgerRetentionDaysFromStored(bad)).toBe(14);
  });

  it("행에서 바로 읽는다(30초 스냅숏이 아니다)", async () => {
    const queries: string[] = [];
    const executor = (rows: unknown[]) => ({ execute: async (query: ReturnType<typeof sql>) => { queries.push(render(query).sql); return rows; } });
    expect(await readModelCapacityLedgerRetentionDays(executor([{ days: 21 }]) as never)).toBe(21);
    expect(queries[0]).toContain(`rs."values"->'capacity'->'ledgerRetentionDays'`);
    expect(await readModelCapacityLedgerRetentionDays(executor([]) as never)).toBe(14);
  });

  it("관리자가 고치는 실시간 설정 — 범위 밖은 거절 문장, 칸은 장비 한도 화면의 「모델 장부 보관」", () => {
    expect(resolveRuntimeSettings({ version: 1 }).settings.capacity).toEqual({ unknownHoldSeconds: 600, ledgerRetentionDays: 14 });
    expect(resolveRuntimeSettings({ version: 1, capacity: { ledgerRetentionDays: 30 } })).toMatchObject({ settings: { capacity: { ledgerRetentionDays: 30 } }, issues: [] });
    expect(resolveRuntimeSettings({ version: 1, capacity: { ledgerRetentionDays: 7 } }))
      .toMatchObject({ settings: { capacity: { ledgerRetentionDays: 14 } }, issues: ["runtime_settings_invalid:capacity.ledgerRetentionDays"] });
    expect(RUNTIME_SETTING_LABELS["capacity.ledgerRetentionDays"]).toBe("끝난 모델 장부 보관(일)");
    expect(runtimeSettingsIssueMessage("runtime_settings_invalid:capacity.ledgerRetentionDays")).toBe("끝난 모델 장부 보관(일): 범위를 벗어났습니다(8~90)");
    const control = buildSettingsControl({ values: { version: 1 }, revision: 3 } as never, LEDGER_RETENTION_CONTROL);
    expect(control.fields).toMatchObject([{ path: "capacity.ledgerRetentionDays", kind: "int", value: 14, defaultInput: "14", overridden: false }]);
    const form = new FormData();
    form.set("value:capacity.ledgerRetentionDays", "21"); form.set("initial:capacity.ledgerRetentionDays", "14"); form.set("stored:capacity.ledgerRetentionDays", "0");
    expect(runtimeSettingsPatchFromForm("capacity", form)).toEqual({ patch: { capacity: { ledgerRetentionDays: 21 } }, changed: ["capacity.ledgerRetentionDays"], issues: [] });
  });
});

describe("모델 장부 지울 후보 SQL", () => {
  it("끝난 행·기한만 고르고, 감사가 찾은 다섯 갈래(작업·결과·교정·사람 검토·생성·대상·열쇠)를 빼며 NULL 이면 남긴다", () => {
    const { sql: text, params } = render(ledgerCandidatesSql(14, "settled"));
    expect(text).toContain("r.state = $1");
    expect(params).toContain("settled");
    expect(text).toContain("r.settled_at < clock_timestamp() - make_interval(days =>");
    for (const part of ["FROM llm_assist_work w", "FROM llm_assist_results x", "FROM intro_assist_corrections c",
      "r.state = 'withdrawn' AND r.terminal_evidence IS NOT NULL", "s.dispatch_binding->>'kind' = 'crawl_tagline_gateway'",
      "s.dispatch_binding->>'kind' = 'search_verify_gateway'", "r.logical_member_keys &&", "r.logical_work_key IN"]) expect(text).toContain(part);
    expect(text).toMatch(/NOT coalesce\(/);
    expect(text).toMatch(/\), true\)\s+ORDER BY r\.settled_at LIMIT/);
    expect(render(ledgerCandidatesSql(8, "withdrawn")).sql).toContain("ORDER BY r.updated_at LIMIT");
  });
});

describe("수집 원본 줄이기 — 남기는 키", () => {
  it("남기는 키 목록은 읽는 곳 전수에서 모은 것과 같다(has_issues·node_id 포함, URL·개수·license 등 제외)", () => {
    expect([...REPO_META_KEEP_KEYS].sort()).toEqual(["archived", "created_at", "default_branch", "description", "fork", "full_name", "has_issues", "homepage",
      "id", "language", "name", "node_id", PACKAGE_PROOF_KEY, "owner", "private", "pushed_at", "stargazers_count", "topics"].sort());
    expect([...REPO_META_OWNER_KEEP_KEYS]).toEqual(["login", "id", "node_id", "type"]);
    const text = render(shrunkRepoMetaSql(sql`d.repo_meta`)).sql;
    for (const key of REPO_META_KEEP_KEYS) expect(text).toContain(`'${key}'`);
    expect(text).not.toContain("'license'");
  });

  it("남기는 키만으로 판정·스팸·소개 증거·스타 자동 승인·스타 수가 같은 답을 낸다", () => {
    const meta: Record<string, unknown> = {
      id: 123, node_id: "R_x", name: "tool", full_name: "Owner/tool", private: false, fork: false, archived: false, description: "Download now free tool",
      homepage: "https://tool.example", topics: ["cli"], language: "Go", stargazers_count: 1, created_at: "2026-01-01T00:00:00Z", pushed_at: "2026-10-01T00:00:00Z",
      default_branch: "main", has_issues: false, [PACKAGE_PROOF_KEY]: [{ kind: "skill", path: "SKILL.md" }],
      owner: { login: "Owner", id: 9, node_id: "U_9", type: "User", avatar_url: "a", html_url: "h", site_admin: false },
      license: { key: "mit" }, forks_count: 3, watchers_count: 1, open_issues_count: 2, size: 10, visibility: "public", has_pages: true, html_url: "https://github.com/Owner/tool",
      permissions: { pull: true }, organization: { login: "org" }, updated_at: "2026-10-02T00:00:00Z", url: "https://api.github.com/repos/Owner/tool",
    };
    const keep = new Set<string>(REPO_META_KEEP_KEYS), ownerKeep = new Set<string>(REPO_META_OWNER_KEEP_KEYS);
    const shrunk = Object.fromEntries(Object.entries(meta).filter(([key]) => keep.has(key)).map(([key, value]) => [key, key === "owner"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([inner]) => ownerKeep.has(inner))) : value]));
    const document = (repoMeta: Record<string, unknown>) => ({ repo: "Owner/tool", repoMeta, productUrl: "https://tool.example", pageStatus: 200,
      pageMeta: { title: "Tool", textSample: "free download" }, fetchedAt: new Date("2026-11-15T00:00:00Z") });
    const settings = { judge: { autoApproveMinStars: 0 } } as never;
    for (const read of [
      (d: ReturnType<typeof document>) => factsFromRepoMeta(d.repo, d.repoMeta), (d: ReturnType<typeof document>) => judgeRevision(d),
      (d: ReturnType<typeof document>) => spamSignals(d), (d: ReturnType<typeof document>) => taglineEvidence(d.repo, d),
      (d: ReturnType<typeof document>) => starAutoApproval(d, settings, new Date("2026-11-15T01:00:00Z")),
      (d: ReturnType<typeof document>) => parseRepositoryStats(d.repoMeta),
    ]) expect(read(document(shrunk))).toEqual(read(document(meta)));
  });
});

describe("잡 시간 나누기", () => {
  it("남은 틱 시간을 아직 돌지 않은 부분 수로 나눈다 — 마감을 모르면 8초", () => {
    expect(partSliceMs(undefined, 5)).toBe(DB_RETENTION_PART_SLICE_MS);
    expect(partSliceMs(25_000, 5, 0)).toBe(5_000);
    expect(partSliceMs(25_000, 1, 20_000)).toBe(5_000);
    expect(partSliceMs(25_000, 2, 30_000)).toBe(0);
  });
});
