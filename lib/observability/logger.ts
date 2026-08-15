/**
 * JSON 한 줄 로거.
 *
 * 외부 서비스를 붙이지 않는다 — stdout으로 내보내면 Dokploy가 수집한다.
 * 한 줄 JSON인 이유는 사람이 읽기 위해서가 아니라 나중에 grep/jq로 걸러내기 위해서다.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): number {
  const configured = (process.env.LOG_LEVEL ?? "info") as LogLevel;
  return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
}

/** 값에 비밀이 담길 수 있는 키 — 로그에 절대 원문이 나가면 안 된다 */
const SECRET_KEY = /token|secret|password|authorization|cookie|apikey|api_key/i;

/**
 * 로그 필드에서 비밀값을 가린다.
 * 실수로 edit_token이나 verify_token을 통째로 넘겨도 원문이 남지 않도록,
 * 호출부의 주의가 아니라 로거 자체가 막는다.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[깊이초과]";
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 4) };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Fields = Record<string, unknown>;

function emit(level: LogLevel, event: string, fields: Fields) {
  if (LEVEL_ORDER[level] < minLevel()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(redact(fields) as Fields),
  });
  // 에러는 stderr로 분리해 로그 수집기가 심각도를 구분할 수 있게 한다
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  debug: (event: string, fields: Fields = {}) => emit("debug", event, fields),
  info: (event: string, fields: Fields = {}) => emit("info", event, fields),
  warn: (event: string, fields: Fields = {}) => emit("warn", event, fields),
  error: (event: string, fields: Fields = {}) => emit("error", event, fields),
};
