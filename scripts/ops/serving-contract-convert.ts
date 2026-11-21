/**
 * abcllm 계약 → 직접 연결(openai-chat-total-bound-v1, provider local-direct) 전환과 되돌리기(2026-11-21 abcllm 이름표 정리 2·3단계).
 * 관리 화면(/admin/models/contracts 「abcllm 계약 → 직접 연결 전환」)과 같은 함수(lib/operations/serving-contract-convert.ts)를 부른다.
 *
 *   node --import tsx scripts/ops/serving-contract-convert.ts gate [--json]
 *       계약 읽기 관문만 읽는다(최근 10분의 서비스 관측·역할 lease·역할 후보 — 옛 판 프로세스 목록). 닫혀 있으면 종료 코드 3
 *   node --import tsx scripts/ops/serving-contract-convert.ts plan --route=<경로> [--model=<장부 이름>] [--action=convert|revert] [--json]
 *       계획(dry-run, 쓰지 않는다): 바뀔 계약·덧붙일 정책 route·거절과 까닭·관문·확인할 것. 실행할 수 없으면(관문 닫힘·바꿀 것 없음) 종료 코드 3
 *   node --import tsx scripts/ops/serving-contract-convert.ts apply --route=<경로> [--model=<장부 이름>] [--action=convert|revert] --hash=<계획 hash 64자> --operator=<이름> [--json]
 *       계획 hash 가 지금 다시 만든 계획과 같을 때만 한 TX 에서 쓴다(관리 저장·정책 덧붙이기·감사 한 줄). 다르면 거절(종료 코드 1) — plan 부터 다시
 *
 * DATABASE_URL 은 앱과 같은 것을 쓴다(운영 컨테이너 안에서 돌린다 — 키를 다시 넣지 않으므로 키 암호화 설정은 없어도 된다). 3단계 절차(경로마다 소유자 승인,
 * 배포 창 밖, 잡 일시중지 → 줄에 선 abcllm 장부 행 0 확인 → plan → apply → 재개 → 확인)는 docs/plans/2026-11-21-abcllm-label-cleanup.md 를 따른다.
 * 출력에는 키가 없다(계약 JSON 에 키가 들지 않는다). 계약의 API 주소는 나온다 — 공개 저장소·공개 채널에 붙이지 않는다.
 */
import { contractReaderGateText, readContractReaderGate } from "@/lib/operations/contract-reader-gate";
import { applyServingContractConversion, conversionPlanLines, planServingContractConversion, type ConversionAction } from "@/lib/operations/serving-contract-convert";

type Args = { command: string; route: string | null; model: string | null; action: ConversionAction | null; hash: string | null; operator: string | null; json: boolean };
const OPTIONS = new Set(["route", "model", "action", "hash", "operator"]);

/** --key=value 와 --json 만. 모르는·중복 옵션은 거절한다(사용법 종료 코드 2). */
export function parseServingContractConvertArgs(argv: readonly string[]): Args | null {
  const [command = "", ...rest] = argv;
  const values = new Map<string, string>();
  let json = false;
  for (const arg of rest) {
    if (arg === "--json") { if (json) return null; json = true; continue; }
    const match = /^--([a-z]+)=([^\n]*)$/.exec(arg);
    if (!match || !OPTIONS.has(match[1]) || values.has(match[1]) || !match[2]) return null;
    values.set(match[1], match[2]);
  }
  const action = values.get("action") ?? null;
  if (action !== null && action !== "convert" && action !== "revert") return null;
  return { command, route: values.get("route") ?? null, model: values.get("model") ?? null, action: action as ConversionAction | null,
    hash: values.get("hash") ?? null, operator: values.get("operator") ?? null, json };
}

const USAGE = "usage: gate [--json] | plan --route=<경로> [--model=<이름>] [--action=convert|revert] [--json] | "
  + "apply --route=<경로> [--model=<이름>] [--action=convert|revert] --hash=<64hex> --operator=<이름> [--json]";

/** 명령 하나 → 종료 코드(0 성공 · 1 거절·실패 · 2 사용법 · 3 관문 닫힘·실행할 것 없음). */
export async function runServingContractConvert(argv: readonly string[], out: (line: string) => void = line => console.log(line),
  err: (line: string) => void = line => console.error(line)): Promise<number> {
  const args = parseServingContractConvertArgs(argv);
  if (!args) { err(USAGE); return 2; }
  if (args.command === "gate") {
    const gate = await readContractReaderGate();
    out(args.json ? JSON.stringify(gate) : contractReaderGateText(gate));
    return gate.ok ? 0 : 3;
  }
  if (args.command !== "plan" && args.command !== "apply" || !args.route) { err(USAGE); return 2; }
  const action = args.action ?? "convert";
  if (args.command === "plan") {
    const plan = await planServingContractConversion({ action, routeId: args.route, model: args.model });
    if (args.json) out(JSON.stringify(plan));
    else for (const line of conversionPlanLines(plan)) out(line);
    if (!args.json) out(`hash=${plan.planHash}`);
    return plan.blocked ? 3 : 0;
  }
  if (!args.hash || !/^[a-f0-9]{64}$/.test(args.hash) || !args.operator) { err(USAGE); return 2; }
  try {
    const result = await applyServingContractConversion({ action, routeId: args.route, model: args.model, planHash: args.hash }, args.operator);
    if (args.json) out(JSON.stringify(result));
    else {
      for (const row of result.saved) out(`${action === "convert" ? "전환" : "되돌림"} ${row.model} #${row.previousId} → #${row.id} (${row.contractHash.slice(0, 12)})`);
      for (const route of result.appended) out(`정책 덧붙임 ${route.routeId} / ${route.provider} / ${route.model} → ${route.providerBudgetId} · ${route.groupId}`);
      if (result.policyRevision !== null) out(`정책 판 ${result.policyRevision}`);
      for (const refusal of result.refusals) out(`그대로 둠 ${refusal.model}: ${refusal.reason}`);
    }
    return 0;
  } catch (error) {
    err(JSON.stringify({ code: error instanceof Error && /^[a-z][a-z0-9_:.-]{2,160}$/.test(error.message) ? error.message : "serving_contract_convert_failed" }));
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runServingContractConvert(process.argv.slice(2)).then(code => process.exit(code), error => {
    console.error(JSON.stringify({ code: error instanceof Error && /^[a-z][a-z0-9_:.-]{2,160}$/.test(error.message) ? error.message : "serving_contract_convert_failed" }));
    process.exit(1);
  });
}
