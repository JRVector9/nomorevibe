/**
 * abcllm 이름표 정리 3단계 전의 견줌(D-6) — 경로·계약(API 주소 + 모델)마다 같은 실제 입력으로 지금 abcllm 계약의 wire 와 새 모양
 * (openai-chat-total-bound-v1, context_strategy 없음)의 wire 를 한 번씩 보내 결과를 견준다. 규칙은 lib/operations/contract-shape-compare.ts.
 *
 *   node --import tsx scripts/ops/contract-shape-compare.ts --route=<경로> [--model=<장부 이름>] [--samples=N] [--max-per-contract=N] [--json] [--out=<파일>]
 *       dry-run(기본, 엔진을 부르지 않는다): 견줄 계약(모델·호스트만)·제외와 까닭·표본 id·호출 수·첫 표본의 wire 칸 차이(실제 준비 함수로 확인)
 *   … 같은 인자 + --execute
 *       계약마다 표본 × 2 회(기본 5건 → 10회, --max-per-contract), 모두 80회 상한, 한 번에 하나, 호출 사이 0.75초(칸이 1 인 장비는 2초)를
 *       용량 장부를 거치지 않고 엔진에 바로 보낸다(운영자 측정). 첫 429·Retry-After·잔여량 0 헤더·연속 두 번의 시간 초과/전송 오류/5xx 에서 그 계약을 멈춘다.
 *       DB 에는 쓰지 않는다.
 *   외부 API 계약(rateLimitBackoff 가 있거나 사설·tailnet 주소가 아님 — EXAONE 등)과 지금 순위·묶음 구성원에 없는 계약은 --model=<장부 이름> 으로
 *   콕 집어야만 부른다. 경로 꺼짐·잡 멈춤·순위 꺼짐·DR fence·DRAIN 이면 실행하지 않는다(종료 코드 3).
 *
 * 운영 text-m3 컨테이너 안에서 돌린다 — 앱과 같은 DATABASE_URL(DB_POOLER_MODE 포함)·암호 상자 키(NMV_SECRET_BOX_KEY)로 계약 키를 메모리 안에서만 연다.
 * 실행 전체가 withReadOnlyAiTaskModels 범위 안이다(순위를 다시 읽을 때 앱이 하는 연결 키 채우기 — DB 쓰기·엔진 GET /models — 를 하지 않는다).
 * 출력·JSON 에는 키·주소 전체가 없다(계약은 host:port 만, 검색어 번역은 hash·길이만).
 * --out=<파일>: 끝난 보고서(JSON)를 그 파일에, 호출마다의 기록을 <파일>.jsonl 에 바로바로 덧붙인다(도중에 끊겨도 잰 것이 남는다). 두 파일 모두 0600.
 * 3단계 절차와 순서는 docs/plans/2026-11-21-abcllm-label-cleanup.md.
 * 종료 코드: 0 끝남 · 1 실패 · 2 사용법 · 3 실행할 수 없음(경로 꺼짐·잡 멈춤·계약 없음·표본 없음·호출 상한 초과 — dry-run 에서도 같다).
 */
import { appendFile, chmod, writeFile } from "node:fs/promises";
import { withReadOnlyAiTaskModels } from "@/lib/llm/ai-task-models-snapshot";
import { parseShapeCompareArgs, runShapeCompare, SHAPE_COMPARE_LIMITS, shapeCompareSummaryLines, type ShapeCompareDeps,
  type ShapeCompareHooks } from "@/lib/operations/contract-shape-compare";

const USAGE = `usage: --route=<경로> [--model=<장부 이름>] [--samples=1..${SHAPE_COMPARE_LIMITS.maxSamples}] [--max-per-contract=1..${SHAPE_COMPARE_LIMITS.maxSamples}]`
  + " [--execute] [--json] [--out=<파일>]";

/** 0600 으로 쓴다 — 이미 있던 파일을 덮어써도 권한을 다시 맞춘다(writeFile 의 mode 는 새로 만들 때만 먹는다) */
export async function writePrivate(path: string, text: string): Promise<void> {
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}
/** --out 의 JSONL 기록(계획 한 줄, 호출마다 한 줄, 멈춤마다 한 줄) — 줄마다 바로 덧붙인다 */
function journal(path: string): ShapeCompareHooks {
  const line = (value: unknown) => appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return {
    onPlan: plan => writePrivate(path, `${JSON.stringify({ type: "plan", plan })}\n`),
    onRecord: record => line({ type: "record", record }),
    onStop: stop => line({ type: "stop", stop }),
  };
}

/** 명령 하나 → 종료 코드. deps 를 주지 않으면 실제 읽기·보내기(contract-shape-compare-run.ts)를 쓴다. */
export async function runContractShapeCompare(argv: readonly string[], out: (line: string) => void = line => console.log(line),
  err: (line: string) => void = line => console.error(line), deps?: ShapeCompareDeps): Promise<number> {
  const args = parseShapeCompareArgs(argv);
  if (!args) { err(USAGE); return 2; }
  // 실행 전체(계약·순위 읽기, 뒤에서 도는 다시 읽기까지)를 연결 키 채우기가 꺼진 범위에서 돌린다
  const report = await withReadOnlyAiTaskModels(async () => runShapeCompare(args,
    deps ?? (await import("@/lib/operations/contract-shape-compare-run")).createShapeCompareDeps(), args.out ? journal(`${args.out}.jsonl`) : {}));
  if (args.out) await writePrivate(args.out, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) out(JSON.stringify(report));
  else {
    for (const line of shapeCompareSummaryLines(report)) out(line);
    if (args.out) out(`JSON: ${args.out} · 호출 기록: ${args.out}.jsonl`);
  }
  return report.plan.blocked ? 3 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runContractShapeCompare(process.argv.slice(2)).then(code => process.exit(code), error => {
    console.error(JSON.stringify({ code: error instanceof Error && /^[a-z][a-z0-9_:.-]{2,160}$/.test(error.message) ? error.message : "contract_shape_compare_failed" }));
    process.exit(1);
  });
}
