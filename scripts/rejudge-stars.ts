/**
 * 기본은 읽기 전용이다. 계획을 검토하고 설정을 바꾼 뒤 명시적으로 적용한다.
 * npx tsx scripts/rejudge-stars.ts --out=.crawl-samples/stars-plan.json
 * npx tsx scripts/rejudge-stars.ts --apply=.crawl-samples/stars-plan.json --receipt=.crawl-samples/stars-receipt.json
 * npx tsx scripts/rejudge-stars.ts --revert=.crawl-samples/stars-receipt.json
 * DATABASE_URL은 실행 환경에서 주입한다. 프로드 풀러에는 DB_POOLER_MODE=pgbouncer도 필요하다.
 */
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { applyStarRejudge, planStarRejudge, revertStarRejudge } from "@/lib/crawl/rejudge";

function persist(file: string, value: unknown) {
  // 기존 계획/영수증을 덮지 않는다. 실패하면 부분 파일은 남을 수 있지만 DB 변경은 롤백된다.
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  const directory = openSync(dirname(file), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

async function main() {
  const { values } = parseArgs({ options: {
    out: { type: "string" }, apply: { type: "string" }, receipt: { type: "string" },
    revert: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("읽기 전용: --out=계획.json | 적용: --apply=계획.json --receipt=새영수증.json | 되돌림: --revert=영수증.json");
    return;
  }
  if ([values.out, values.apply, values.revert].filter(v => v !== undefined).length > 1
    || Boolean(values.apply) !== Boolean(values.receipt)
    || Object.values(values).some(v => v === "")) throw new Error("인자 조합을 확인하세요 (--help)");
  if (values.apply) {
    const receipt = await applyStarRejudge(JSON.parse(readFileSync(values.apply, "utf8")), r => persist(values.receipt!, r));
    console.log(`적용 ${receipt.entries.length}건 · 변경되어 건너뜀 ${receipt.skipped}건 · 영수증 ${values.receipt}`);
    return;
  }
  if (values.revert) {
    const result = await revertStarRejudge(JSON.parse(readFileSync(values.revert, "utf8")));
    console.log(`되돌림 ${result.reverted}건 · 이미 처리/변경되어 보존 ${result.skipped}건 (설정은 변경하지 않음)`);
    return;
  }
  const plan = await planStarRejudge();
  if (values.out) persist(values.out, plan);
  console.log(`읽기 전용 · 자동 거부 ${plan.entries.length}건 · 상한 ${plan.fromMaxStars} → ${plan.toMaxStars}`);
  for (const [min, max] of [[2000, 5000], [5000, 10000], [10000, 30000], [30000, 100000]]) {
    const rows = plan.entries.filter(e => e.stars >= min && e.stars < max);
    console.log(`${min}–${max - 1}: ${rows.length}건 (개인 ${rows.filter(e => e.ownerType === "User").length}건)`);
  }
  const counts: Record<string, number> = {};
  for (const entry of plan.entries) {
    const key = `${entry.preview.state}/${entry.preview.reason}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log("저장 원본의 규칙 미리보기:", JSON.stringify(counts));
  console.log("AI·2차 심사·최신 근거·중복/차단 확인은 기존 잡이 수행합니다. 미리보기는 발행 승인이 아닙니다.");
  console.log(values.out ? `계획: ${values.out} (적용 전 검토 필요)` : "--out=파일로 전체 대상 목록을 저장할 수 있습니다.");
}

main().then(() => process.exit(0), () => {
  // 드라이버 오류는 SQL 매개변수·연결 정보를 담을 수 있어 원문을 출력하지 않는다.
  console.error("실패: 인자·입력 JSON·새 출력 경로·DB 연결·계획의 설정을 확인하세요. DB 커밋 여부가 불명확하면 영수증으로 상태를 먼저 확인하세요.");
  process.exit(1);
});
