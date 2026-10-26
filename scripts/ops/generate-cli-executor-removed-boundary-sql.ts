/** The SQL shape snapshot comes from the same strict Zod contract; cross-field/time/row guards remain explicit; no manual validation is claimed. */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { cliExecutorRemovedEvidenceShape } from "../../lib/llm/cli-executor-removed-boundary-contract";
const schema = z.toJSONSchema(cliExecutorRemovedEvidenceShape);
const allowed = new Set(["$schema","type","properties","required","additionalProperties","const","enum","oneOf","anyOf","prefixItems","format","pattern","minLength","maxLength","minimum","exclusiveMinimum","maximum","items","minItems","maxItems"]);
function check(s: unknown) {
  if (!s || typeof s !== "object") return;
  for (const [k,v] of Object.entries(s)) {
    if (!allowed.has(k)) throw new Error(`unsupported_sql_shape_keyword:${k}`);
    if (k === "properties") Object.values(v as object).forEach(check);
    else if (k === "oneOf" || k === "anyOf" || k === "prefixItems") (v as unknown[]).forEach(check);
    else if (k === "items") check(v);
  }
}
check(schema);
const template = readFileSync(new URL("./cli-executor-removed-boundary-sql.template.sql",import.meta.url),"utf8");
writeFileSync(new URL("../../drizzle/0135_cli_executor_removed_boundary_exit.sql",import.meta.url),template.replace("__EVIDENCE_SHAPE__",JSON.stringify(schema)));
