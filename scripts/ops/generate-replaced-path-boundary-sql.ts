/** The SQL shape and topology snapshots come from the same strict contract; cross-field/time/row guards remain explicit. */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { REPLACED_PATH_OWNERS, REPLACED_PATH_PROVIDERS, replacedPathEvidenceShape } from "../../lib/llm/replaced-path-boundary-contract";
const schema = z.toJSONSchema(replacedPathEvidenceShape);
const allowed = new Set(["$schema","type","properties","required","additionalProperties","const","enum","oneOf","allOf","anyOf","prefixItems","format","pattern","minLength","maxLength","minimum","exclusiveMinimum","maximum","items","minItems","maxItems"]);
function check(s: unknown) {
  if (!s || typeof s !== "object") return;
  for (const [k,v] of Object.entries(s)) {
    if (!allowed.has(k)) throw new Error(`unsupported_sql_shape_keyword:${k}`);
    if (k === "properties") Object.values(v as object).forEach(check);
    else if (k === "oneOf" || k === "allOf" || k === "anyOf" || k === "prefixItems") (v as unknown[]).forEach(check);
    else if (k === "items") check(v);
  }
}
check(schema);
const template = readFileSync(new URL("./replaced-path-boundary-sql.template.sql",import.meta.url),"utf8");
writeFileSync(new URL("../../drizzle/0145_replaced_path_boundary_exit.sql",import.meta.url),template.replace("__EVIDENCE_SHAPE__",JSON.stringify(schema))
  .replace("__OWNERS__",JSON.stringify(REPLACED_PATH_OWNERS)).replace("__PROVIDERS__",JSON.stringify(REPLACED_PATH_PROVIDERS)));
