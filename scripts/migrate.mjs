/**
 * 마이그레이션 실행기.
 *
 * drizzle-kit(devDependency)이 아니라 drizzle-orm의 마이그레이터를 쓴다.
 * standalone 이미지에는 devDependency가 없으므로 drizzle-kit을 부를 수 없다.
 *
 * 평문 .mjs인 이유: 이미지에 tsx나 타입스크립트 런타임을 넣지 않기 위해서다.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL이 없습니다");
  process.exit(1);
}

// 마이그레이션은 단발성이므로 커넥션 하나로 충분하다.
// max:1은 여러 문장이 같은 세션에서 순서대로 실행되게도 한다.
const client = postgres(url, { max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  console.log("[migrate] 완료");
} catch (error) {
  console.error("[migrate] 실패:", error.message);
  process.exit(1);
} finally {
  await client.end();
}
