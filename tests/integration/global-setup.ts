import { execSync } from "node:child_process";
import type { TestProject } from "vitest/node";
import { assertLocalTestDatabase } from "../../scripts/test-database";
import { TEST_DATABASE_URL } from "./test-database-url";

declare module "vitest" {
  export interface ProvidedContext {
    /** 이번 실행에서 globalSetup 이 migrate 를 마친 테스트 DB 주소 */
    integrationSchemaReady: string;
  }
}

/**
 * 통합 테스트 한 번 실행(vitest run 한 번)에 공유 테스트 DB 스키마를 한 번만 최신으로 맞춘다.
 *
 * 예전에는 파일마다 `npx drizzle-kit migrate` 를 새로 띄웠다(파일당 약 0.75초 × 300여 파일). 공유 DB 의
 * 마이그레이션 기록(drizzle.__drizzle_migrations)을 고치는 테스트는 없으므로 두 번째부터는 늘 아무것도 적용하지
 * 않았다 — 기록을 지우는 health-schema 등은 자기 DB 를 따로 만든다. 그래서 첫 migrate 결과를 provide 로 넘기고,
 * setup.ts 의 ensureSchema() 는 같은 주소면 다시 띄우지 않는다. 자기 DB 를 따로 만드는 파일은 예전처럼 스스로 migrate 한다.
 */
export default function setup(project: TestProject) {
  assertLocalTestDatabase(TEST_DATABASE_URL);
  execSync("npx drizzle-kit migrate", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
  project.provide("integrationSchemaReady", TEST_DATABASE_URL);
}
