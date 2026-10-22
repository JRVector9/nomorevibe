/**
 * 통합 테스트 묶음(shard)을 파일 개수가 아니라 걸린 시간으로 나눈다.
 *
 * vitest 의 기본 `--shard` 는 파일 경로 해시 순으로 개수만 똑같이 자른다. 5분짜리 파일과 1초짜리 파일이
 * 같은 무게라 운 나쁜 묶음이 몇 분씩 늦게 끝났다. 여기서는 기록해 둔 파일별 시간
 * (tests/integration/durations.json)으로 긴 파일부터 가장 가벼운 묶음에 넣는다(LPT).
 * 기록에 없는 새 파일은 기록된 시간의 중앙값으로 친다.
 *
 * 묶음마다 같은 커밋·같은 파일 목록·같은 기록으로 계산하므로 모든 runner 가 같은 배정을 얻는다.
 * vitest 설정(tests/integration/duration-sequencer.ts)과 기록 갱신 스크립트(scripts/integration-durations.mjs)가 함께 쓴다.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DURATIONS_PATH = 'tests/integration/durations.json';

/**
 * 빈 테스트 DB 에서 이 순서대로 하나씩 따로 실행해야 하는 파일(CI 의 integration-ledger 잡).
 * 지울 수 없는 ledger 행·sequence 를 처음 상태에서 보고, 각 파일은 끝날 때 같은 행 기준 상태를 복원한다 —
 * 뒤 파일은 앞 파일이 복원한 기준 위에서 돈다. 묶음(shard) 실행은 이 파일들을 --exclude 로 뺀다.
 */
export const SERIAL_FILES = [
  'tests/integration/product-translation-capacity-ledger.test.ts', // 빈 DB 의 제품 번역 ledger
  'tests/integration/product-translation-model-capacity.test.ts', // 복원된 ledger 기준 위 제품 번역 호출
  'tests/integration/product-tagline-ko-capacity-ledger.test.ts', // 복원된 제품 번역 기준 위 한국어 소개 ledger
  'tests/integration/korean-tagline-capacity-dispatch.test.ts',
  'tests/integration/model-capacity-crawl-tagline-ledger.test.ts', // 복원된 한국어 기준 위 crawl 소개 ledger
  'tests/integration/crawl-tagline-capacity-dispatch.test.ts',
  'tests/integration/search-verify-capacity-dispatch.test.ts', // 복원된 crawl 기준 위 검색어 검수 호출
  'tests/integration/model-capacity-websearch-query-ledger.test.ts',
  'tests/integration/model-capacity-cli-ledger.test.ts', // 복원된 웹 검색 기준 위 CLI 프로세스 ledger
  'tests/integration/cli-background-model-capacity.test.ts',
  'tests/integration/review-cli-capacity-dispatch.test.ts', // AI1·AI2 CLI 호출
  'tests/integration/reason-translation-capacity-ledger.test.ts',
  'tests/integration/reason-translation-capacity-dispatch.test.ts',
  'tests/integration/text-profile-capacity-dispatch.test.ts',
  'tests/integration/agent-review-item-model-capacity.test.ts', // AI1 native 항목 흐름
  'tests/integration/second-review-item-model-capacity.test.ts', // AI2 native 항목 흐름
  'tests/integration/pipeline-consumer.test.ts', // AI2 소비자
  'tests/integration/pipeline-first-consumer.test.ts', // 복원된 AI2 행 기준 위 AI1 소비자
];

/**
 * 저장소 기준 상대 경로 → 초. 파일이 없거나 깨졌으면 빈 기록(모든 파일이 같은 무게)으로 돌아간다
 * @returns {Record<string, number>}
 */
export function readDurations(root = process.cwd()) {
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, DURATIONS_PATH), 'utf8'));
    const files = parsed?.files;
    if (!files || typeof files !== 'object') return {};
    return Object.fromEntries(Object.entries(files)
      .filter(([file, seconds]) => typeof file === 'string' && Number.isFinite(seconds) && seconds >= 0));
  } catch {
    return {};
  }
}

function median(values) {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * files 를 count 개 묶음으로 나눈다. 반환값의 i 번째가 (i+1)/count 묶음이다.
 * 긴 파일부터(같으면 경로순) 지금 가장 가벼운 묶음(같으면 앞 번호)에 넣는다 — 입력 순서와 상관없이 결정적이다.
 * @param {string[]} files
 * @param {Record<string, number>} durations
 * @param {number} count
 * @returns {{ files: string[], seconds: number }[]}
 */
export function planShards(files, durations, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error('integration_shard_count_invalid');
  const fallback = median(Object.values(durations));
  const weighted = [...new Set(files)].map(file => ({ file, seconds: durations[file] ?? fallback }))
    .sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  for (const { file, seconds } of weighted) {
    let lightest = 0;
    for (let index = 1; index < count; index++) if (shards[index].seconds < shards[lightest].seconds) lightest = index;
    shards[lightest].files.push(file);
    shards[lightest].seconds += seconds;
  }
  return shards;
}

// node scripts/integration-shards.mjs --serial        직렬 파일을 실행 순서대로 한 줄에 하나
// node scripts/integration-shards.mjs --exclude-args  묶음 실행에 붙일 `--exclude <파일>` 목록
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (mode === '--serial') console.log(SERIAL_FILES.join('\n'));
  else if (mode === '--exclude-args') console.log(SERIAL_FILES.map(file => `--exclude ${file}`).join(' '));
  else throw new Error('usage: --serial | --exclude-args');
}
