/**
 * 발행분 감사를 연다 — /admin/audit 의 "재감사 시작"과 같은 함수(startProductAudit)를 부른다.
 *
 *   DB_POOLER_MODE=pgbouncer tsx --env-file=.env.local scripts/start-product-audit.ts --by=jr --reason="첫 감사"
 *   … --reaudit-kept      유지 판정도 다시 본다(기본은 뺀다)
 *
 * 배포 직후 첫 감사를 화면을 거치지 않고 열려고 둔다. 마이그레이션이 열지 않는 까닭은 감사를 여는 것이
 * 사람의 결정이어야 해서다. 아무것도 내리지 않는다 — reviewer 워커가 물어 사람이 볼 목록을 채울 뿐이다.
 * 이미 도는 감사가 있으면 열지 않는다.
 */
import { parseArgs } from "node:util";
import { startProductAudit } from "@/lib/crawl/product-audit";

async function main() {
  const { values } = parseArgs({ options: {
    by: { type: "string" }, reason: { type: "string" }, "reaudit-kept": { type: "boolean", default: false },
  } });
  if (!values.by?.trim() || !values.reason?.trim()) {
    console.error("사용법: start-product-audit.ts --by=<누가> --reason=<왜> [--reaudit-kept]");
    return 1;
  }
  const result = await startProductAudit({ startedBy: values.by.trim(), reason: values.reason, reauditKept: values["reaudit-kept"] });
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  console.log(`감사 #${result.campaignId} 시작 · ${result.enrolled}건 올림 · 유지 판정으로 뺀 것 ${result.keptSkipped}건`);
  return 0;
}

main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
