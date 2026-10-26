/** The SQL shape snapshot comes from the same strict Zod contract; cross-field/time/row guards remain explicit and PG-tested. */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { cliExecutorEvidenceShape } from "../../lib/llm/cli-executor-boundary-contract";
const schema = z.toJSONSchema(cliExecutorEvidenceShape);
const allowed = new Set(["$schema","type","properties","required","additionalProperties","const","enum","oneOf","format","pattern","minLength","maxLength","minimum","exclusiveMinimum","maximum","items","minItems","maxItems"]);
function check(s: unknown) {
  if (!s || typeof s !== "object") return;
  for (const [k,v] of Object.entries(s)) {
    if (!allowed.has(k)) throw new Error(`unsupported_sql_shape_keyword:${k}`);
    if (k === "properties") Object.values(v as object).forEach(check);
    else if (k === "oneOf") (v as unknown[]).forEach(check);
    else if (k === "items") check(v);
  }
}
check(schema);
const template = readFileSync(new URL("./cli-executor-boundary-sql.template.sql",import.meta.url),"utf8");
writeFileSync(new URL("../../drizzle/0134_cli_executor_boundary_exit.sql",import.meta.url),template.replace("__EVIDENCE_SHAPE__",JSON.stringify(schema)));
