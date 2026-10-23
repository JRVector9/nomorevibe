import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { assistRolloutManifestSchema, verifyAssistRolloutManifest } from "@/lib/operations/llm-assist-readiness";

// 오프라인 plan 전용이다. 환경 파일·DB·네트워크·배포 API를 열지 않는다.
try {
  const { values } = parseArgs({ options: { manifest: { type: "string" }, out: { type: "string" }, schema: { type: "boolean" } }, strict: true });
  if (values.schema) {
    if (values.manifest || values.out) throw new Error("schema_only");
    process.stdout.write(JSON.stringify(z.toJSONSchema(assistRolloutManifestSchema, { io: "input" }), null, 2) + "\n");
    process.exitCode = 0;
  } else {
    const manifest: unknown = values.manifest ? JSON.parse(readFileSync(values.manifest, "utf8")) : {};
    const result = verifyAssistRolloutManifest(manifest), rendered = JSON.stringify(result, null, 2) + "\n";
    if (values.out) writeFileSync(values.out, rendered, { flag: "wx" });
    else process.stdout.write(rendered);
    process.exitCode = result.productionEligibleForReview ? 0 : 1;
  }
} catch {
  process.stderr.write("검증할 JSON manifest와 새 출력 파일을 지정하세요: --manifest <json> [--out <새 json>]\n");
  process.exitCode = 2;
}
