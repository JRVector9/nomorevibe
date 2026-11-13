import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { modelCapacityEvents, modelCapacityRequests } from "@/lib/db/operations-schema";
import { gatewayHttpRejectedEvidenceSchema, gatewayNoOutcomeEvidenceSchema } from "@/lib/llm/capacity";
import { GATEWAY_HTTP_REJECTED_BINDING_KINDS, GATEWAY_HTTP_REJECTED_RETRY_AFTER_MAX_MS, GATEWAY_HTTP_REJECTED_STATUSES,
  gatewayHttpRejectedEventTerminalSql, gatewayHttpRejectedTerminalSql } from "@/lib/llm/gateway-http-rejected-sql";
import { isGatewayHttpRejectedStatus } from "@/lib/llm/gateway-http-rejected";
import { PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS } from "@/lib/llm/provider-rate-limit";
import { japaneseProductTerminalSql, japaneseProductEventSql } from "@/lib/llm/japanese-product-translation-sql";

/**
 * 0174(2026-11-11) gateway_http_rejected: journal·파일 모양·Drizzle 선언·TS/SQL 목록 일치만 본다. 실제 DB 적용·guard 판정·정산·읽는 쪽은
 * tests/integration/gateway-http-rejected-ledger.test.ts, ledger-check-rules.test.ts(0174), 각 text 경로 *-capacity-dispatch 시험이 본다.
 */
const tag = "0174_gateway_http_rejected";
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string; version: string; breakpoints: boolean }[] };
const migration = readFileSync(`drizzle/${tag}.sql`, "utf8");
const statements = migration.split("--> statement-breakpoint");
const code = migration.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");

it("registers 0174 right after 0173 with a strictly increasing when", () => {
  const index = journal.entries.findIndex(entry => entry.tag === tag);
  expect(journal.entries[index]).toEqual({ idx: 174, version: "7", when: 1794172801084, tag, breakpoints: true });
  expect(journal.entries[index - 1]).toMatchObject({ idx: 173, tag: "0173_review_attempt_model_outcome" });
  expect(journal.entries[index].when).toBeGreaterThan(journal.entries[index - 1].when);
});

it("appends exactly two idempotent rules rows (requests and events terminal) with the schema constants byte for byte, then rebuilds both guards", () => {
  const added = [...migration.matchAll(/SELECT '(model_capacity_requests|model_capacity_events)', '([^']+)', COALESCE\(MAX\(ordinal\), 0\) \+ 1, \$branch\$([\s\S]*?)\$branch\$, '([^']+)'/g)];
  expect(added.map(match => match.slice(1))).toEqual([
    ["model_capacity_requests", "model_capacity_requests_terminal_check", gatewayHttpRejectedTerminalSql, tag],
    ["model_capacity_events", "model_capacity_events_terminal_check", gatewayHttpRejectedEventTerminalSql, tag]]);
  expect(migration.match(new RegExp(`COUNT\\(\\*\\) FILTER \\(WHERE source = '${tag}'\\) = 0`, "g"))).toHaveLength(2);
  expect(migration.match(/COUNT\(\*\) FILTER \(WHERE source = '0160_ledger_check_rules'\) >= 1/g)).toHaveLength(2);
  expect(statements[0]).toContain("SET LOCAL lock_timeout='5s';");
  expect(statements[1].trim()).toBe("LOCK TABLE model_capacity_check_rules IN SHARE ROW EXCLUSIVE MODE;");
  expect(statements.at(-2)!.trim()).toBe("SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests');");
  expect(statements.at(-1)!.trim()).toBe("SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_events');");
  // 장부 표를 잠그거나 고치지 않는다 — 행·제약·트리거·함수·권한 변경 없음
  expect(code).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\s|INSERT INTO model_capacity_(?:requests|events)\b|CREATE |GRANT |ALTER TABLE|LOCK TABLE model_capacity_(?:requests|events)/);
  for (const branch of [gatewayHttpRejectedTerminalSql, gatewayHttpRejectedEventTerminalSql]) expect(branch).not.toContain("$branch$");
});

it("Drizzle composes both terminal CHECKs as (previous) OR (0174 branch) and leaves every other ledger CHECK alone", () => {
  for (const [table, name, branch] of [[modelCapacityRequests, "model_capacity_requests_terminal_check", gatewayHttpRejectedTerminalSql],
    [modelCapacityEvents, "model_capacity_events_terminal_check", gatewayHttpRejectedEventTerminalSql]] as const) {
    let expression = new PgDialect().sqlToQuery(getTableConfig(table).checks.find(check => check.name === name)!.value).sql;
    const japanese = table === modelCapacityRequests ? japaneseProductTerminalSql : japaneseProductEventSql;
    const japaneseTail = `) OR (${japanese})`;
    expect(expression.startsWith("(") && expression.endsWith(japaneseTail), `${name}: 0184 additive tail present`).toBe(true);
    expression = expression.slice(1, -japaneseTail.length);
    expect(expression.startsWith("(") && expression.endsWith(`) OR (${branch})`), name).toBe(true);
  }
  for (const check of [...getTableConfig(modelCapacityRequests).checks, ...getTableConfig(modelCapacityEvents).checks]) {
    if (check.name.endsWith("_terminal_check")) continue;
    expect(new PgDialect().sqlToQuery(check.value).sql, check.name).not.toContain("gateway_http_rejected");
  }
});

it("the SQL branches, the evidence schema and the gateway agree on kinds, statuses and the Retry-After bound", () => {
  expect([...GATEWAY_HTTP_REJECTED_STATUSES]).toEqual([401, 403, 429]);
  expect([...GATEWAY_HTTP_REJECTED_BINDING_KINDS]).toEqual(["text_profile_gateway", "reason_translation_gateway", "product_translation_gateway",
    "product_tagline_ko_gateway", "crawl_tagline_gateway", "search_verify_gateway", "websearch_query_gateway"]);
  expect(GATEWAY_HTTP_REJECTED_RETRY_AFTER_MAX_MS).toBe(PROVIDER_RATE_LIMIT_RETRY_AFTER_MAX_MS);
  const list = `('${GATEWAY_HTTP_REJECTED_BINDING_KINDS.join("','")}')`;
  expect(gatewayHttpRejectedTerminalSql).toContain(`dispatch_binding->>'kind' IN ${list}`);
  expect(gatewayHttpRejectedEventTerminalSql).toContain(`evidence->'dispatch'->'binding'->>'kind' IN ${list}`);
  for (const sql of [gatewayHttpRejectedTerminalSql, gatewayHttpRejectedEventTerminalSql]) {
    expect(sql).toContain("IN ('401'::jsonb,'403'::jsonb,'429'::jsonb)");
    expect(sql).toContain("ARRAY['version','kind','dispatch','status','retryAfterMs']");
    expect(sql).toContain("::integer <= 3600000");
    expect(sql).not.toMatch(/local_model_direct|ai1_|ai2_|publication_classify/);
  }
  expect(gatewayHttpRejectedEventTerminalSql).toContain("from_state='dispatched' AND to_state='settled'");
  expect(gatewayHttpRejectedEventTerminalSql).not.toContain("indeterminate");
  for (const status of [400, 404, 408, 413, 422, 500, 502, 503, 504, 200, 307]) expect(isGatewayHttpRejectedStatus(status), String(status)).toBe(false);
  for (const status of GATEWAY_HTTP_REJECTED_STATUSES) expect(isGatewayHttpRejectedStatus(status)).toBe(true);
  const shape = gatewayHttpRejectedEvidenceSchema.shape;
  for (const status of [401, 403, 429]) expect(shape.status.safeParse(status).success).toBe(true);
  for (const status of [400, 500, "429", 429.5]) expect(shape.status.safeParse(status).success).toBe(false);
  for (const value of [null, 0, 120_000, 3_600_000]) expect(shape.retryAfterMs.safeParse(value).success).toBe(true);
  for (const value of [-1, 1.5, 3_600_001, "120"]) expect(shape.retryAfterMs.safeParse(value).success).toBe(false);
  // 결과 없는 정산을 읽는 쪽은 두 kind 를 같은 길로 받는다
  expect(gatewayNoOutcomeEvidenceSchema.options).toHaveLength(2);
});
