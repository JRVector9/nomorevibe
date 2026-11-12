import { getTableName, sql, type Column, type SQL } from "drizzle-orm";

/**
 * 표 이름을 붙인 칸("표"."칸") — select 목록·returning 의 상관 서브쿼리에서 바깥 표의 칸을 가리킬 때 쓴다.
 *
 * drizzle 은 join 없는 select 와 insert·update·delete 의 returning 에서 select 목록의 sql 조각 맨 바깥에 놓인 칸을 표 이름 없이("id")
 * 그린다(drizzle-orm pg-core dialect buildSelection, isSingleTable). 그 칸이 서브쿼리 안에 있고 안쪽 표에 같은 이름의 칸이 있으면
 * Postgres 는 안쪽 칸으로 묶는다 — 오류 없이 틀린 값이 된다. where·order by 는 같은 조각을 "표"."칸" 으로 그려 맞으므로, 같은 식이
 * select 목록에서만 다른 값을 낸다. 2026-11-11 1차 심사 쪽 커서가 「심사한 적 있음」을 늘 false 로 저장해 새 후보 1,030건이 굶었다.
 * 이 함수는 표 이름(별칭이면 별칭)을 직접 적어, 어느 자리에 놓여도 같은 글자로 그려진다.
 */
export function qualifiedColumn(column: Column): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}
