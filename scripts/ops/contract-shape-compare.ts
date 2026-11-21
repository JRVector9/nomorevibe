/**
 * abcllm 이름표 정리 3단계 전의 견줌(D-6) — 경로·계약(API 주소 + 모델)마다 같은 실제 입력으로 지금 abcllm 계약의 wire 와 새 모양
 * (openai-chat-total-bound-v1, context_strategy 없음)의 wire 를 한 번씩 보내 결과를 견준다. 규칙은 lib/operations/contract-shape-compare.ts.
 *
 *   node --import tsx scripts/ops/contract-shape-compare.ts --route=<경로> [--model=<장부 이름>] [--samples=N] [--json] [--out=<파일>]
 *       dry-run(기본, 부르지 않는다): 견줄 계약(모델·호스트만)·제외와 까닭·표본 id·호출 수·첫 표본의 wire 칸 차이(실제 준비 함수로 확인)
 *   … 같은 인자 + --execute
 *       표본 × 계약 × 2 회(상한 80, 한 번에 하나, 호출 사이 0.75초)를 용량 장부를 거치지 않고 엔진에 바로 보낸다(운영자 측정). DB 에는 쓰지 않는다.
 *
 * 운영 text-m3 컨테이너 안에서 돌린다 — 앱과 같은 DATABASE_URL(DB_POOLER_MODE 포함)·암호 상자 키(NMV_SECRET_BOX_KEY)로 계약 키를 메모리 안에서만 연다.
 * 출력·JSON 에는 키·주소 전체가 없다(계약은 host:port 만). --out 파일은 0600 으로 쓴다. 3단계 절차와 순서는 docs/plans/2026-11-21-abcllm-label-cleanup.md.
 * 종료 코드: 0 끝남 · 1 실패 · 2 사용법 · 3 실행할 수 없음(경로 꺼짐·계약 없음·표본 없음·호출 상한 초과 — dry-run 에서도 같다).
 */
import { writeFile } from "node:fs/promises";
import { parseShapeCompareArgs, runShapeCompare, SHAPE_COMPARE_LIMITS, shapeCompareSummaryLines, type ShapeCompareDeps } from "@/lib/operations/contract-shape-compare";

const USAGE = `usage: --route=<경로> [--model=<장부 이름>] [--samples=1..${SHAPE_COMPARE_LIMITS.maxSamples}] [--execute] [--json] [--out=<파일>]`;

/** 명령 하나 → 종료 코드. deps 를 주지 않으면 실제 읽기·보내기(contract-shape-compare-run.ts)를 쓴다. */
export async function runContractShapeCompare(argv: readonly string[], out: (line: string) => void = line => console.log(line),
  err: (line: string) => void = line => console.error(line), deps?: ShapeCompareDeps): Promise<number> {
  const args = parseShapeCompareArgs(argv);
  if (!args) { err(USAGE); return 2; }
  const report = await runShapeCompare(args, deps ?? (await import("@/lib/operations/contract-shape-compare-run")).createShapeCompareDeps());
  if (args.out) await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (args.json) out(JSON.stringify(report));
  else {
    for (const line of shapeCompareSummaryLines(report)) out(line);
    if (args.out) out(`JSON: ${args.out}`);
  }
  return report.plan.blocked ? 3 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runContractShapeCompare(process.argv.slice(2)).then(code => process.exit(code), error => {
    console.error(JSON.stringify({ code: error instanceof Error && /^[a-z][a-z0-9_:.-]{2,160}$/.test(error.message) ? error.message : "contract_shape_compare_failed" }));
    process.exit(1);
  });
}
