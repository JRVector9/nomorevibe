/**
 * 운영 로그에 남길 DB 오류 요약(SQLSTATE·시스템 오류 code, 이름, 잘린 message).
 * drizzle 은 드라이버 오류를 cause 로 감싸고 그 message 에 SQL·params 를 담는다(DrizzleQueryError: "Failed query: ...\nparams: ...").
 * 그래서 감싼 쪽 message 는 쓰지 않고 사슬에서 code 가 있는 첫 오류(없으면 사슬 끝)의 것만 쓴다. detail·query·parameters 는 읽지 않는다.
 */
const MESSAGE_MAX = 160;
function sanitized(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/\S*/gi, 'postgres://<redacted>').replace(/password\s*=\s*\S+/gi, 'password=<redacted>')
    .replace(/\s+/g, ' ').trim().slice(0, MESSAGE_MAX);
}
export type DbErrorFields = { code: string | null; name: string; message: string };
/** cause 사슬(최대 5)과 그중 code 가 있는 첫 오류 */
function errorChain(error: unknown): { chain: unknown[]; coded: Record<string, unknown> | undefined } {
  const chain: unknown[] = [];
  for (let current = error; current !== null && current !== undefined && chain.length < 5; current = (current as { cause?: unknown }).cause) {
    chain.push(current);
    if (typeof current !== 'object') break;
  }
  const coded = chain.find(item => typeof (item as { code?: unknown })?.code === 'string') as Record<string, unknown> | undefined;
  return { chain, coded };
}
export function dbErrorFields(error: unknown): DbErrorFields {
  const { chain, coded } = errorChain(error);
  const picked = coded ?? chain.at(-1);
  if (!(picked instanceof Error)) return { code: null, name: typeof picked, message: '' };
  const wrapper = picked.name === 'DrizzleQueryError' || picked.message.startsWith('Failed query:');
  return { code: coded ? String(coded.code).slice(0, 40) : null, name: picked.name.slice(0, 60),
    message: wrapper ? '' : sanitized(picked.message) };
}

/**
 * PostgreSQL 드라이버 오류의 SQLSTATE 와 대상 이름(표·제약). 잡 실패 기록(jobs.last_error)과 job.failed 로그에 싣는다.
 * drizzle 이 감싼 message("Failed query: …")에는 SQLSTATE 가 없어 교착(40P01)도 일반 실패처럼 보였다(2026-10-29).
 * 식별자만 싣는다 — detail(키 값)·message·params 는 읽지 않는다. 드라이버(PostgresError) 오류가 아니면 null.
 */
export type DbErrorTag = { code: string; table: string | null; constraint: string | null };
const SQLSTATE = /^[0-9A-Z]{5}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
export function dbErrorTag(error: unknown): DbErrorTag | null {
  const { code, name } = dbErrorFields(error);
  if (!code || !SQLSTATE.test(code) || name !== 'PostgresError') return null;
  const { coded } = errorChain(error);
  const identifier = (value: unknown) => typeof value === 'string' && IDENTIFIER.test(value) ? value : null;
  return { code, table: identifier(coded?.table_name), constraint: identifier(coded?.constraint_name) };
}

/** last_error 머리말 — "[40P01] ", "[23505 table=jobs constraint=jobs_pkey] ". 드라이버 오류가 아니면 빈 문자열 */
export function dbErrorPrefix(tag: DbErrorTag | null): string {
  if (!tag) return '';
  return `[${[tag.code, tag.table && `table=${tag.table}`, tag.constraint && `constraint=${tag.constraint}`].filter(Boolean).join(' ')}] `;
}

/** PostgreSQL 이 이 TX 를 교착 희생자로 골랐다(40P01). 그 TX 는 이미 통째로 되돌려졌다 */
export function isDbDeadlock(error: unknown): boolean {
  return dbErrorTag(error)?.code === '40P01';
}
