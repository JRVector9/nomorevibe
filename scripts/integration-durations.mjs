#!/usr/bin/env node
/**
 * 통합 테스트 파일별 시간 기록(tests/integration/durations.json)을 갱신하고 묶음 배정을 보여 준다.
 *
 *   node scripts/integration-durations.mjs --run <CI run id> [<run id>...]  # 그 실행들의 integration-durations-* artifact 로 갱신
 *   node scripts/integration-durations.mjs a.json b.json ...                # 묶음 reporter 가 남긴 JSON 을 직접 모아 갱신
 *   node scripts/integration-durations.mjs --plan 6                         # 지금 기록으로 6 묶음 배정·예상 시간만 출력(쓰지 않는다)
 *
 * 갱신은 이번에 잰 파일만 새 값(여러 실행이면 평균 — runner 마다 같은 파일이 1.5~2배까지 흔들린다)으로 바꾸고, 저장소에서
 * 사라진 파일은 지운다. 재지 않은 파일은 예전 값을 둔다. 기록이 오래되어도 결과는 같고 묶음 균형만 나빠진다 —
 * 긴 파일이 크게 바뀌었을 때 최근 성공한 PR 실행 두세 개로 갱신한다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DURATIONS_PATH, planShards, readDurations, SERIAL_FILES } from './integration-shards.mjs';

export function listIntegrationFiles(root = process.cwd()) {
  return readdirSync(resolve(root, 'tests/integration'))
    .filter(name => name.endsWith('.test.ts'))
    .map(name => `tests/integration/${name}`)
    .sort();
}

/** 예전 기록 위에 새로 잰 값(같은 파일을 여러 번 쟀으면 평균)을 덮고, 지금 없는 파일은 뺀다. 키는 경로순으로 둔다 */
export function mergeDurations(previous, reports, existing) {
  const measured = new Map();
  for (const report of reports) {
    for (const [file, seconds] of Object.entries(report?.files ?? {})) {
      if (Number.isFinite(seconds) && seconds >= 0) measured.set(file, [...(measured.get(file) ?? []), seconds]);
    }
  }
  const merged = { ...previous };
  for (const [file, values] of measured) merged[file] = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10;
  const keep = new Set(existing);
  return Object.fromEntries(Object.entries(merged).filter(([file]) => keep.has(file)).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function jsonFilesUnder(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? jsonFilesUnder(path) : name.endsWith('.json') ? [path] : [];
  });
}

/** CI 묶음과 같은 대상(직렬 ledger 파일 제외)으로 배정을 보여 준다 */
function printPlan(count, root) {
  const durations = readDurations(root);
  const serial = new Set(SERIAL_FILES);
  const files = listIntegrationFiles(root).filter(file => !serial.has(file));
  const plan = planShards(files, durations, count);
  plan.forEach((shard, index) => console.log(`${index + 1}/${count}: ${shard.files.length} files ~${Math.round(shard.seconds)}s`));
  const missing = files.filter(file => !(file in durations));
  if (missing.length) console.log(`기록 없는 파일 ${missing.length}개(중앙값으로 계산): ${missing.join(', ')}`);
}

function main(argv) {
  const root = process.cwd();
  if (argv[0] === '--plan') {
    printPlan(Number(argv[1] ?? 6), root);
    return;
  }
  let inputs = argv;
  let downloaded;
  const runs = argv[0] === '--run' ? argv.slice(1) : [];
  if (argv[0] === '--run') {
    if (runs.length === 0 || !runs.every(run => /^\d+$/.test(run))) throw new Error('usage: --run <run id> [<run id>...]');
    downloaded = mkdtempSync(join(tmpdir(), 'nmv-integration-durations-'));
    for (const run of runs) {
      execFileSync('gh', ['run', 'download', run, '--pattern', 'integration-durations-*', '--dir', join(downloaded, run)], { stdio: 'inherit' });
    }
    inputs = jsonFilesUnder(downloaded);
  }
  try {
    if (inputs.length === 0) throw new Error('no duration reports');
    const reports = inputs.map(path => JSON.parse(readFileSync(path, 'utf8')));
    const files = mergeDurations(readDurations(root), reports, listIntegrationFiles(root));
    const target = resolve(root, DURATIONS_PATH);
    const previous = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
    const source = runs.length ? `GitHub Actions runs ${runs.join(', ')}` : 'local reports';
    writeFileSync(target, `${JSON.stringify({ ...previous, source, files }, null, 2)}\n`);
    console.log(`${DURATIONS_PATH}: ${Object.keys(files).length} files (${source})`);
    printPlan(6, root);
  } finally {
    if (downloaded) rmSync(downloaded, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
