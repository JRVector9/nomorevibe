import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { generate } from "../release-order-doc";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// 확정본 21·22단계: 문서의 생성기가 런북에서 뽑은 SQL(A1~A5, T0~T9)을 대표가 쓰는 실행기와 같은 방식
// (READ ONLY 트랜잭션, 5초 제한, tx.unsafe 한 문장)으로 실제 마이그레이션 스키마에 돌린다. 운영 값은 아니고 문법·열 이름만 본다.
const sql = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
beforeAll(() => { ensureSchema(); });
afterAll(async () => { await sql.end({ timeout: 5 }); });

it.each(["ai2", "text"] as const)("%s 생성기가 만든 SQL이 READ ONLY 실행기에서 오류 없이 돈다", async (kind) => {
  const { status, files } = generate(kind, "2026-10-30T01:02:03.123456789Z");
  expect(status).toBe(0);
  expect(Object.keys(files).length).toBe(kind === "ai2" ? 5 : 10);
  for (const [name, text] of Object.entries(files)) {
    const rows = await sql.begin("read only", async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = 5000");
      return tx.unsafe(text);
    }).catch((error: unknown) => { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); });
    expect(Array.isArray(rows), name).toBe(true);
  }
});
