import type postgres from "postgres";

/**
 * 0160 뒤 장부 CHECK 여섯 개(requests dispatch·logical·members·terminal, events kind·terminal)는 pg_constraint 가 아니라
 * model_capacity_check_rules 의 행(제약 이름·가지 순번·술어)과 nmv_<표>_check_guard() 트리거로 산다. 마이그레이션 이력 시험이
 * 0160 앞뒤 어느 DB 에서나 같은 모양("CHECK (<술어>)", pg_get_constraintdef 와 같은 글자)을 읽도록 두 출처를 합쳐 준다.
 * 가지가 둘 이상이면 "(가지1) OR (가지2)" 로 잇는다 — 0158 까지의 live rebuild 가 pg_get_constraintdef 에 남긴 꼴과 같다.
 */
export async function ledgerCheckDefs(sql: postgres.Sql, names: readonly string[]): Promise<Record<string, string>> {
  const list = [...names];
  const defs = Object.fromEntries((await sql<{ name: string; def: string }[]>`SELECT conname AS name, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE contype = 'c' AND conname = ANY(${list}::text[])`).map(row => [row.name, row.def]));
  for (const [name, expression] of Object.entries(await ledgerCheckExpressions(sql, list.filter(name => !(name in defs)), false))) defs[name] = `CHECK (${expression})`;
  return defs;
}

/** pg_get_expr(conbin, conrelid) 꼴(바깥 괄호 없는 술어). 두 출처(pg_constraint, 0160 rules)를 합친다. */
export async function ledgerCheckExpressions(sql: postgres.Sql, names: readonly string[], includeConstraints = true): Promise<Record<string, string>> {
  const list = [...names];
  const expressions: Record<string, string> = {};
  if (list.length === 0) return expressions;
  if (includeConstraints) {
    for (const row of await sql<{ name: string; expression: string }[]>`SELECT conname AS name, pg_get_expr(conbin, conrelid) AS expression
      FROM pg_constraint WHERE contype = 'c' AND conname = ANY(${list}::text[])`) expressions[row.name] = row.expression;
  }
  const [{ present }] = await sql<{ present: boolean }[]>`SELECT to_regclass('model_capacity_check_rules') IS NOT NULL AS present`;
  if (!present) return expressions;
  for (const row of await sql<{ name: string; expression: string }[]>`SELECT constraint_name AS name,
      CASE WHEN count(*) = 1 THEN min(predicate) ELSE string_agg('(' || predicate || ')', ' OR ' ORDER BY ordinal) END AS expression
    FROM model_capacity_check_rules WHERE constraint_name = ANY(${list}::text[]) GROUP BY constraint_name`) {
    if (!(row.name in expressions)) expressions[row.name] = row.expression;
  }
  return expressions;
}

/** 0160 이 트리거로 옮긴 장부 CHECK 이름(표별, 알파벳 순서 = PostgreSQL 의 CHECK 평가 순서). */
export const LEDGER_RULE_CHECKS = {
  model_capacity_requests: ["model_capacity_requests_dispatch_check", "model_capacity_requests_logical_check", "model_capacity_requests_members_check",
    "model_capacity_requests_terminal_check"],
  model_capacity_events: ["model_capacity_events_kind_check", "model_capacity_events_terminal_check"],
} as const;
