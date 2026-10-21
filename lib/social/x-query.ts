import { X_QUERY_MAX_LENGTH, xSearchQuery } from "./x-pilot";

/**
 * X 검색어를 우리 공개 제품의 저장소로 만든다(2026-10-21 사용자 지시). 고정 검색어(x-collector.ts 의 X_COLLECTOR_QUERY)로는
 * 7일 동안 본 저장소 17곳 중 우리 제품이 1곳이라 /talk 에 X 글이 하나도 오르지 못했다.
 *
 * 저장소 하나가 `url:"github.com/owner/repo"` 한 조각이고 조각끼리 OR 로 잇는다. X 의 url: 은 글의 주소(url·expanded_url)를
 * 낱말로 잘라 맞춘다(docs.x.com 연산자 표 "Tokenized match on URL"). 빗금·점이 든 경로는 따옴표로 묶는다(엔터프라이즈 연산자 안내의
 * `url:"/developer"`). 낱말 맞춤이라 이름이 더 긴 저장소(owner/repo-plus)나 그 저장소의 이슈 주소도 잡힐 수 있다 —
 * 받은 글이 가리킨 저장소는 수집기가 주소에서 다시 읽는다(x-pilot.ts).
 *
 * 웹(/api/ops/x-query)이 오늘의 목록을 고르고, 수집기가 같은 xRepositoryQuery 로 검색어를 만든다. 512자 검사는 runXPilot 한 곳이다.
 */
const OWNER = "[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?";
const REPOSITORY = new RegExp(`^${OWNER}/[a-z0-9_.-]{1,100}$`);
const SEPARATOR = " OR ";
/** 감싸는 괄호와 -is:retweet 을 뺀 검색어 길이 상한 */
const QUERY_ROOM = X_QUERY_MAX_LENGTH - xSearchQuery("").length;

/** 소문자 owner/repo — . 과 .. 은 이름이 아니다 */
export const isXQueryRepository = (value: unknown): value is string =>
  typeof value === "string" && REPOSITORY.test(value) && ![".", ".."].includes(value.slice(value.indexOf("/") + 1));
export const repositoryTerm = (repository: string) => `url:"github.com/${repository}"`;
/** 가장 짧은 조각(a/b)과 이음말 — 남은 자리가 이보다 작으면 더 볼 것이 없다 */
const SHORTEST = SEPARATOR.length + repositoryTerm("a/b").length;

/** 앞에서부터 검색어 512자 안에 드는 저장소만 — 들지 않는 것은 건너뛰고 다음 것을 본다. 하나도 없으면 null */
export function xRepositoryQuery(repositories: readonly string[]): { query: string; repositories: string[] } | null {
  const used: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  for (const repository of repositories) {
    if (!isXQueryRepository(repository) || seen.has(repository)) continue;
    const added = (used.length ? SEPARATOR.length : 0) + repositoryTerm(repository).length;
    if (length + added > QUERY_ROOM) {
      if (QUERY_ROOM - length < SHORTEST) break;
      continue;
    }
    seen.add(repository);
    used.push(repository);
    length += added;
  }
  return used.length ? { query: used.map(repositoryTerm).join(SEPARATOR), repositories: used } : null;
}

/** 공개 제품 하나 — 등재 시각(ms)과, 스타가 느는 중이면 하루 평균 증가(아니면 null) */
export type XQueryCandidate = { id: number; repository: string; listedAt: number; gain: number | null };
/** '새로 오른' 제품의 기간 */
export const X_QUERY_RECENT_DAYS = 14;
/**
 * 하루 검색어에서 차례(모든 공개 제품을 돌아가며)가 쓰는 자리(글자) — 이음말까지 센 조각들의 길이.
 * 흔한 이름(20자 안팎)으로 하루 3~4곳이다. 남은 자리(약 330자, 7~8곳)는 새로 오른·스타가 느는 제품이 쓴다.
 * 가장 긴 조각(owner 39자 + repo 100자)도 157자라 차례 첫 자리에는 늘 든다.
 */
export const X_QUERY_ROTATION_CHARS = 160;

/**
 * 오늘의 저장소 목록과 다음 차례가 시작할 곳.
 *
 * 1. 차례: 저장소마다 먼저 등록된 제품 하나를 id 순으로 세우고, 지난번 차례의 마지막 id(after) 다음부터 160자만큼 — 끝에 닿으면 처음으로 돈다.
 *    웹은 날마다 이어 가는 자리(next)를 적어 두므로(x-query-receive.ts) 제품이 늘거나 줄어도 건너뛰거나 겹치지 않는다.
 * 2. 먼저 볼 것: 스타가 느는 제품(하루 평균 증가 큰 순)과 14일 안에 오른 제품(새것 순)을 하나씩 번갈아 남은 자리를 채운다.
 * 차례를 앞에 두어 먼저 볼 것이 많아도 차례가 밀리지 않는다. 같은 저장소는 한 번만 넣는다.
 */
export function planXQueryRepositories(candidates: readonly XQueryCandidate[], options: { now: number; after: number }): { repositories: string[]; next: number } {
  const byRepository = new Map<string, XQueryCandidate>();
  for (const item of [...candidates].sort((a, b) => a.id - b.id))
    if (isXQueryRepository(item.repository) && !byRepository.has(item.repository)) byRepository.set(item.repository, item);
  const ordered = [...byRepository.values()];

  const start = ordered.findIndex(item => item.id > options.after);
  const rotation = start <= 0 ? ordered : [...ordered.slice(start), ...ordered.slice(0, start)];
  const turn: XQueryCandidate[] = [];
  let length = 0;
  for (const item of rotation) {
    const added = (turn.length ? SEPARATOR.length : 0) + repositoryTerm(item.repository).length;
    if (length + added > X_QUERY_ROTATION_CHARS) break;
    turn.push(item);
    length += added;
  }

  const rising = ordered.filter(item => item.gain !== null && item.gain > 0).sort((a, b) => b.gain! - a.gain! || a.id - b.id);
  const recentSince = options.now - X_QUERY_RECENT_DAYS * 86_400_000;
  const recent = ordered.filter(item => item.listedAt >= recentSince).sort((a, b) => b.listedAt - a.listedAt || b.id - a.id);
  const first: string[] = [];
  for (let index = 0; index < Math.max(rising.length, recent.length); index++)
    for (const item of [rising[index], recent[index]]) if (item) first.push(item.repository);

  const chosen = xRepositoryQuery([...turn.map(item => item.repository), ...first]);
  return { repositories: chosen?.repositories ?? [], next: turn.at(-1)?.id ?? options.after };
}
