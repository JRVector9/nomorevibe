/**
 * drizzle/0158_release_branch_kinds.sql 생성기. 0155·0157 과 같은 live rebuild — CHECK 마다 지금 pg_get_constraintdef 의 술어 전체를 왼쪽에
 * 그대로 두고 lib/llm/dispatch-release-kinds-sql.ts 의 상수를 $ai2_local$ 로 감싸 OR 로 덧붙인다(스키마 이력 테스트가 그 태그로 가지를 읽는다).
 * 실행: npx tsx scripts/ops/generate-release-branch-kinds-sql.ts
 */
import { writeFileSync } from "node:fs";
import { publicationClassifyReleaseLogicalSql, releaseKindsDispatchSql } from "../../lib/llm/dispatch-release-kinds-sql";

const header = `-- 0158 (2026-10-31): 종료 근거 회수(0096 process_group_exit·dr_call_drain → withdrawn)에 publication_classify_cli(발행 분류 CLI, 0125)와
-- local_model_direct(gpu3090·M3 직접 호출, 0118·0155) 를 더한다. 0096 의 회수 가지는 kind 16개를 못 박았고 그 뒤 두 kind 는 자기 dispatch 가지로만
-- 통과하는데, publication_classify 의 0125 가지(dispatch·logical·members)는 terminal_evidence 를 cli_model_terminal 로만 받아
-- lib/operations/dr/reclaim.ts 의 process_group_exit 회수 UPDATE 가 23514 로 깨졌다(2026-10-31 publisher 컨테이너 사망 뒤 고아 행 1건).
-- 0155·0157 과 같은 live rebuild: 세 CHECK(요청 logical·members·dispatch) 마다 지금 pg_get_constraintdef 의 술어 전체를 왼쪽에 그대로 두고
-- 가지 하나를 OR 로 더한다 — dispatch 는 0096 회수 가지에서 kind 목록만 두 kind 로 바꾼 것(두 kind 모두 binding 최상위에 version·logicalWorkKey·model 이 있어
-- 같은 조건을 만족한다), logical·members 는 0125 publication_classify 정체 조건 + withdrawn + 종료 근거(0096 이 CLI 묶음 kind 에 둔 꼴).
-- terminal CHECK 의 withdrawn 가지와 events kind CHECK 의 dispatch_released 가지는 binding kind 를 보지 않아 바꾸지 않는다.
-- 가지 값은 lib/llm/dispatch-release-kinds-sql.ts 의 상수다(scripts/ops/generate-release-branch-kinds-sql.ts 가 이 파일을 만든다). $ai2_local$ 인용 태그는
-- 스키마 이력 테스트가 알아보는 표식이다. 함수·트리거·인덱스·권한·열·행·해시는 바뀌지 않는다. 기존 행은 원래 가지로 계속 통과한다.`;

const block = (name: string, branch: string) => `DO $$
DECLARE old_predicate text;
BEGIN
  SELECT substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate
    FROM pg_constraint WHERE conrelid='model_capacity_requests'::regclass AND conname='${name}';
  ALTER TABLE model_capacity_requests DROP CONSTRAINT ${name};
  EXECUTE format('ALTER TABLE model_capacity_requests ADD CONSTRAINT ${name} CHECK ((%s) OR (%s))',
    old_predicate, $ai2_local$${branch}$ai2_local$);
END $$;`;

const statements = [
  header,
  block("model_capacity_requests_logical_check", publicationClassifyReleaseLogicalSql),
  block("model_capacity_requests_members_check", publicationClassifyReleaseLogicalSql),
  block("model_capacity_requests_dispatch_check", releaseKindsDispatchSql),
];
for (const branch of [publicationClassifyReleaseLogicalSql, releaseKindsDispatchSql]) if (branch.includes("$ai2_local$")) throw new Error("quoting_tag_collision");
writeFileSync(new URL("../../drizzle/0158_release_branch_kinds.sql", import.meta.url), `${statements.join("\n--> statement-breakpoint\n")}\n`);
