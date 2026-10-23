import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { evaluateAssistResponses } from "@/lib/domain/llm-assist/evaluation";

// 오프라인 전용: 네트워크·DB·운영 환경 파일을 읽지 않는다.
const { values } = parseArgs({ options: { dataset: { type: "string" }, responses: { type: "string" }, out: { type: "string" } }, strict: true });
if (!values.dataset || !values.responses) throw new Error("usage: --dataset <json> --responses <jsonl> [--out <json>]");
const dataset: unknown = JSON.parse(readFileSync(values.dataset, "utf8"));
const responses: unknown[] = readFileSync(values.responses, "utf8").split(/\r?\n/).filter(line => line.trim())
  .map(line => JSON.parse(line));
const result = JSON.stringify(evaluateAssistResponses(dataset, responses), null, 2) + "\n";
if (values.out) writeFileSync(values.out, result);
else process.stdout.write(result);
