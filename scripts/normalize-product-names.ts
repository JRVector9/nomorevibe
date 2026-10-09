/**
 * 기존 제품 이름 정리(UX-33) — 페이지 제목이 그대로 이름이 된 주인 없는 공개분을 지금 규칙(display-name.ts reviewProductName)으로 고친다.
 * 관리자 제품 목록의 '이름 확인 필요'와 같은 목록이다. 기본은 보여 주기만 한다.
 *
 *   tsx --env-file=.env.local scripts/normalize-product-names.ts                       (계획만 — 아무것도 바꾸지 않는다)
 *   tsx --env-file=.env.local scripts/normalize-product-names.ts --out=plan.json       (계획을 파일로 남긴다)
 *   tsx --env-file=.env.local scripts/normalize-product-names.ts --apply --actor=이름  (지금 계획을 적용 — 되돌리기 파일을 쓴다)
 *   tsx --env-file=.env.local scripts/normalize-product-names.ts --apply --plan=plan.json --actor=이름  (검토한 그 파일대로 적용)
 *   tsx --env-file=.env.local scripts/normalize-product-names.ts --revert=revert.json --actor=이름
 *
 * 적용·되돌리기는 지금 이름이 계획의 이전 값과 같을 때만 바꾸고(그 사이 누가 고쳤으면 그쪽을 지킨다), 관리자 작업 로그에 한 줄 남긴다.
 * 되돌리기 파일은 --revert-out 이 없으면 .crawl-samples/(git 제외) 아래에 쓴다. 프로드에서는 DB_POOLER_MODE=pgbouncer 가 필요하다.
 * 이름이 바뀌면 검색 키워드가 다시 지어진다(0048 트리거) — 1천 건이면 키워드 잡이 한두 시간 더 돈다.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { NAME_ISSUE_LABELS } from "@/lib/domain/products/display-name";
import { applyNameChangesWithLog, planNameChanges, reverseNameChanges, type NameChange } from "@/lib/domain/products/name-review";

type Plan = { createdAt: string; changes: NameChange[] };

function show(changes: NameChange[]) {
  const counts = new Map<string, number>();
  for (const change of changes) for (const issue of change.issues) counts.set(issue, (counts.get(issue) ?? 0) + 1);
  console.log(`고칠 이름 ${changes.length}건 — ${[...counts].sort((a, b) => b[1] - a[1]).map(([issue, n]) => `${NAME_ISSUE_LABELS[issue as keyof typeof NAME_ISSUE_LABELS]} ${n}`).join(" · ")}`);
  for (const change of changes.slice(0, 40)) console.log(`  ${change.before.slice(0, 60).padEnd(60)} → ${change.after}`);
  if (changes.length > 40) console.log(`  … ${changes.length - 40}건 더`);
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 1), { mode: 0o600, flag: "wx" });
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    out: { type: "string" }, apply: { type: "boolean", default: false }, plan: { type: "string" }, revert: { type: "string" },
    actor: { type: "string" }, "revert-out": { type: "string" },
  } });
  const applying = values.apply;
  if ((applying || values.revert) && !values.actor?.trim()) throw new Error("--apply·--revert 에는 --actor=이름 이 필요합니다 (작업 로그에 남는다)");

  if (values.revert) {
    const plan: Plan = JSON.parse(readFileSync(values.revert, "utf8"));
    const result = await applyNameChangesWithLog(reverseNameChanges(plan.changes), { actor: values.actor!, revert: true, revertFile: values.revert });
    console.log(`되돌림 ${result.applied.length}건 · 그 사이 바뀌어 건너뜀 ${result.skipped}건`);
    return result;
  }

  const plan: Plan = values.plan
    ? JSON.parse(readFileSync(values.plan, "utf8"))
    : await planNameChanges().then(({ changes, guessSuggestions, repoSuggestions, withoutProposal }) => {
      // 짐작한 제안·저장소 이름으로 대신한 제안·제안 없음은 자동으로 바꾸지 않는다 — 관리자 '이름 확인 필요'에서 사람이 고른다
      console.log(`사람이 볼 것: 짐작한 제안 ${guessSuggestions.length}건 · 저장소 이름 제안 ${repoSuggestions.length}건 · 제안 없음 ${withoutProposal.length}건 (관리자 '이름 확인 필요')`);
      return { createdAt: new Date().toISOString(), changes };
    });
  show(plan.changes);
  if (values.out) {
    writeJson(values.out, plan);
    console.log(`${values.out} 에 남겼습니다. 검토한 뒤 --apply --plan=${values.out} 로 적용합니다.`);
  }
  if (!applying) {
    console.log("보여 주기만 했습니다(dry-run). 바꾸려면 --apply --actor=이름");
    return { applied: [], skipped: 0 };
  }
  const revertFile = values["revert-out"] ?? `.crawl-samples/product-names-${plan.createdAt.replace(/[:.]/g, "-")}-revert.json`;
  // 되돌리기 파일을 먼저 쓴다 — 쓸 수 없으면 아무것도 바꾸지 않는다. 건너뛴 것이 섞여 있어도 되돌리기는 지금 이름이
  // 바꾼 뒤 값과 같을 때만 움직이므로 그대로 쓸 수 있다
  writeJson(revertFile, plan);
  const result = await applyNameChangesWithLog(plan.changes, { actor: values.actor!, revert: false, revertFile });
  console.log(`적용 ${result.applied.length}건 · 그 사이 바뀌어 건너뜀 ${result.skipped}건 · 되돌리기 ${revertFile}`);
  return result;
}

if (process.argv[1]?.endsWith("normalize-product-names.ts")) {
  main().then(() => process.exit(0), (error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
