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
export function dbErrorFields(error: unknown): DbErrorFields {
  const chain: unknown[] = [];
  for (let current = error; current !== null && current !== undefined && chain.length < 5; current = (current as { cause?: unknown }).cause) {
    chain.push(current);
    if (typeof current !== 'object') break;
  }
  const coded = chain.find(item => typeof (item as { code?: unknown })?.code === 'string');
  const picked = coded ?? chain.at(-1);
  if (!(picked instanceof Error)) return { code: null, name: typeof picked, message: '' };
  const wrapper = picked.name === 'DrizzleQueryError' || picked.message.startsWith('Failed query:');
  return { code: coded ? String((coded as { code: string }).code).slice(0, 40) : null, name: picked.name.slice(0, 60),
    message: wrapper ? '' : sanitized(picked.message) };
}
