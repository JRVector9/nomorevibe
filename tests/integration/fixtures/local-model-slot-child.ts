import { requestLocalModelSlot, requestModelSlot } from "../../../lib/llm/capacity-repository";
import { assertLocalTestDatabase } from "../../../scripts/test-database";

// 격리 DB 예약만 경쟁한다. 모델·worker·운영 endpoint를 실행하지 않는다.
async function main() {
  assertLocalTestDatabase(process.env.DATABASE_URL ?? "");
  const raw = await new Promise<string>(resolve => {
  let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => resolve(input));
});
  const { request, target } = JSON.parse(raw);
  const result = target ? await requestLocalModelSlot(request, target) : await requestModelSlot(request);
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}
void main().catch(error => { process.stderr.write(String(error)); process.exit(1); });
