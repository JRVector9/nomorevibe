import { hostname } from "node:os";
import { basename, isAbsolute } from "node:path";
import { runXCollector, type XCollectorOptions } from "../lib/social/x-collector";
import type { XReportConfig } from "../lib/social/x-report";

/** 보고 주소 — https 만, 사용자 정보·조각 없이 */
function reportUrl(value: string | undefined, invalid: () => never): string | null {
  if (value === undefined || value === "") return null;
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) invalid();
  return url.toString();
}

/**
 * 웹 보고 설정 — 비밀(32바이트 이상)이 없으면 보내지 않는다. 비밀만 있고 주소가 하나도 없으면 설정 오류.
 * X_QUERY_URL(2026-10-21 검색 저장소 묻기)은 없앴다 — env 에 남아 있어도 읽지 않는다(값이 틀려도 설정 오류가 아니다).
 */
function reportConfig(environment: Record<string, string | undefined>, invalid: () => never): XReportConfig | undefined {
  const secret = environment.X_STATUS_REPORT_SECRET;
  if (!secret) return undefined;
  if (Buffer.byteLength(secret) < 32 || /[\s\u007f]/.test(secret)) invalid();
  const statusUrl = reportUrl(environment.X_STATUS_REPORT_URL, invalid), postsUrl = reportUrl(environment.X_POSTS_REPORT_URL, invalid);
  if (!statusUrl && !postsUrl) invalid();
  return { secret, statusUrl, postsUrl };
}

export function xCollectorConfig(args: string[], environment: Record<string, string | undefined>, host: string): XCollectorOptions {
  const invalid = (): never => { throw new Error("invalid_configuration"); };
  if (args.length > 1 || (args.length === 1 && !["--live", "--dry-run"].includes(args[0]))) invalid();
  for (const value of [environment.X_COLLECTION_LIVE, environment.X_USE_CASE_APPROVED])
    if (value !== undefined && !["0", "1"].includes(value)) invalid();
  const live = args[0] === "--live" || (!args.length && environment.X_COLLECTION_LIVE === "1");
  if (live && host !== "osaka-smoke") invalid();
  const stateDir = environment.X_STATE_DIR ?? "/var/lib/nomorevibe-x";
  if (!isAbsolute(stateDir) || stateDir === "/" || /[\u0000-\u001f\u007f]/.test(stateDir)) invalid();
  const report = reportConfig(environment, invalid);
  return { live, stateDir, useCaseApproved: environment.X_USE_CASE_APPROVED === "1", token: environment.X_BEARER_TOKEN, ...(report ? { report } : {}) };
}

async function main() {
  const result = await runXCollector(xCollectorConfig(process.argv.slice(2), process.env, hostname()));
  console.log(JSON.stringify(result));
  if (result.status === "stopped" || (result.status === "blocked" && result.reason !== "daily_limit")) process.exitCode = 1;
}

if (process.argv[1] && /^x-collector\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => {
    console.error("X collector stopped: invalid_configuration_or_state");
    process.exitCode = 1;
  });
}
