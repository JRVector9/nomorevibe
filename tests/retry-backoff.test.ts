import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { retryBackoffSql } from "@/lib/db/retry-backoff";
import { crawlTaglines, productKoreanTaglines, productSearchProfiles, textTranslations } from "@/lib/db/schema";

const dialect = new PgDialect();
const rendered = (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
  const { sql: text, params } = dialect.sqlToQuery(query);
  return { sql: text, params };
};
const expression = (attempts: string) =>
  `now() + least(interval '24 hours', interval '5 minutes' * power(2, least(${attempts}, 9)))`;

describe("retryBackoffSql", () => {
  it("열 참조는 지수 9에서 자른 뒤 24시간으로 한한다", () => {
    expect(rendered(retryBackoffSql(crawlTaglines.attempts))).toEqual({
      sql: expression(`"crawl_taglines"."attempts"`), params: [],
    });
    expect(rendered(retryBackoffSql(productSearchProfiles.attempts))).toEqual({
      sql: expression(`"product_search_profiles"."attempts"`), params: [],
    });
    expect(rendered(retryBackoffSql(productSearchProfiles.verifyAttempts))).toEqual({
      sql: expression(`"product_search_profiles"."verify_attempts"`), params: [],
    });
    expect(rendered(retryBackoffSql(textTranslations.attempts))).toEqual({
      sql: expression(`"text_translations"."attempts"`), params: [],
    });
  });

  it("원시 식별자와 바인딩된 시도 수도 같은 식으로 넣는다", () => {
    expect(rendered(sql`CASE WHEN ${false} THEN NULL ELSE ${retryBackoffSql(sql`t.attempts`)} END`)).toEqual({
      sql: `CASE WHEN $1 THEN NULL ELSE ${expression("t.attempts")} END`, params: [false],
    });
    expect(rendered(retryBackoffSql(sql`${35}`))).toEqual({ sql: expression("$1"), params: [35] });
  });

  it("같은 원문일 때만 쌓인 시도 수를 지수로 쓴다", () => {
    const same = sql`${productKoreanTaglines.sourceTagline} = excluded.source_tagline`;
    expect(rendered(retryBackoffSql(sql`case when ${same} then ${productKoreanTaglines.attempts} else 0 end`))).toEqual({
      sql: expression(`case when "product_korean_taglines"."source_tagline" = excluded.source_tagline then "product_korean_taglines"."attempts" else 0 end`),
      params: [],
    });
  });
});
