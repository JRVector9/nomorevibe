import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync } from 'node:zlib';

/**
 * 첫 로드 JS 기준선(PERF-06) — next build 뒤 주요 화면이 처음 받는 JS 를 brotli 로 재서 기준선과 견준다.
 *
 * Next 16 은 build 출력에서 'First Load JS' 표를 뺐다. 대신 Turbopack 빌드가 화면마다 처음 받는 청크 목록과
 * 원본 크기를 .next/diagnostics/route-bundle-stats.json 에 남긴다. 여기서는 그 청크들을 br 로 눌러 더한다 —
 * 방문자가 실제로 받는 크기에 가깝고, 2026-10-08 점검의 수치(약 150KB br)와 같은 잣대다.
 * 기준선보다 허용 폭 넘게 커지면 실패한다. 의도한 증가라면 빌드 뒤 `node scripts/bundle-size.mjs --update` 로 기준선을 고쳐 커밋한다.
 */

export const STATS_FILE = '.next/diagnostics/route-bundle-stats.json';
export const BASELINE_FILE = 'scripts/bundle-baseline.json';

/** 청크마다 한 번만 누른다 — 화면들이 공통 청크를 나눠 쓴다 */
export function brotliSizer(readChunk) {
  const cache = new Map();
  return (path) => {
    if (!cache.has(path)) cache.set(path, brotliCompressSync(readChunk(path)).length);
    return cache.get(path);
  };
}

/** 기준선에 있는 화면만 잰다. 빌드 통계에 없는 화면은 brotliBytes 가 null 이다(이름이 바뀌었거나 빌드가 다르다) */
export function measureRoutes(stats, routes, sizeOf) {
  return routes.map((route) => {
    const row = stats.find((entry) => entry.route === route);
    if (!row) return { route, chunks: 0, rawBytes: null, brotliBytes: null };
    const chunks = row.firstLoadChunkPaths.filter((path) => path.endsWith('.js'));
    return { route, chunks: chunks.length, rawBytes: row.firstLoadUncompressedJsBytes,
      brotliBytes: chunks.reduce((sum, path) => sum + sizeOf(path), 0) };
  });
}

/** 잰 값을 기준선과 견준다 — 허용 폭(tolerance, 0.1 = 10%)을 넘거나 화면이 없으면 실패 */
export function compareToBaseline(measured, baseline) {
  return measured.map((row) => {
    const base = baseline.routes[row.route];
    const limit = Math.floor(base * (1 + baseline.tolerance));
    const status = row.brotliBytes === null ? 'missing' : row.brotliBytes > limit ? 'over' : 'ok';
    return { ...row, baseline: base, limit, status };
  });
}

/** 지금 잰 값으로 새 기준선 — 허용 폭과 메모는 그대로 둔다 */
export function updatedBaseline(measured, baseline) {
  const missing = measured.filter((row) => row.brotliBytes === null).map((row) => row.route);
  if (missing.length) throw new Error(`route-bundle-stats.json 에 없는 화면: ${missing.join(', ')}`);
  return { ...baseline, routes: Object.fromEntries(measured.map((row) => [row.route, row.brotliBytes])) };
}

const kb = (bytes) => (bytes === null ? '-' : `${(bytes / 1024).toFixed(1)}KB`);

export function formatReport(rows) {
  return rows.map((row) => `${row.status.padEnd(7)} ${row.route.padEnd(12)} br ${kb(row.brotliBytes).padStart(8)}`
    + ` (기준 ${kb(row.baseline)}, 한도 ${kb(row.limit)}) 원본 ${kb(row.rawBytes)} · 청크 ${row.chunks}개`).join('\n');
}

function main(argv) {
  const root = process.cwd();
  const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  let stats;
  try {
    stats = readJson(STATS_FILE);
  } catch {
    console.error(`${STATS_FILE} 이 없다 — next build(Turbopack) 뒤에 실행한다`);
    return 1;
  }
  const baseline = readJson(BASELINE_FILE);
  const measured = measureRoutes(stats, Object.keys(baseline.routes), brotliSizer((path) => readFileSync(resolve(root, path))));
  if (argv.includes('--update')) {
    writeFileSync(resolve(root, BASELINE_FILE), `${JSON.stringify(updatedBaseline(measured, baseline), null, 2)}\n`);
    console.log(`기준선을 고쳤다: ${BASELINE_FILE}`);
    return 0;
  }
  const rows = compareToBaseline(measured, baseline);
  console.log(formatReport(rows));
  const failed = rows.filter((row) => row.status !== 'ok');
  if (failed.length) {
    console.error(`첫 로드 JS 가 기준선(+${baseline.tolerance * 100}%)을 넘었다: ${failed.map((row) => row.route).join(', ')}`
      + ' — 의도한 증가라면 `node scripts/bundle-size.mjs --update` 로 기준선을 고쳐 커밋한다');
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
