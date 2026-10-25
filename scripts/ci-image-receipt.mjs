import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CI_RULES_VERSION } from './ci-scope.mjs';

const SHA = /^[a-f0-9]{40}$/;
const PREFIX = { worker: 'ghcr.io/jrvector9/nomorevibe-worker@', web: 'ghcr.io/jrvector9/nomorevibe-runtime-web@' };
export function createImageReceipt({ release, tree, kind, digest, runId, runAttempt, testProfile, rulesVersion }) {
  if (!SHA.test(release ?? '') || !SHA.test(tree ?? '') || !Object.hasOwn(PREFIX, kind ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(digest ?? '') || !/^[1-9][0-9]*$/.test(String(runId ?? ''))
    || !Number.isSafeInteger(Number(runId)) || !/^[1-9][0-9]*$/.test(String(runAttempt ?? ''))
    || !Number.isSafeInteger(Number(runAttempt)) || !['full', 'ui'].includes(testProfile)
    || rulesVersion !== CI_RULES_VERSION) throw new Error('image_receipt_invalid');
  return { schemaVersion: 1, release, tree, kind, image: PREFIX[kind] + digest,
    runId: Number(runId), runAttempt: Number(runAttempt), testProfile, rulesVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const receipt = createImageReceipt({ release: process.env.RELEASE_SHA, tree: process.env.HEAD_TREE,
    kind: process.env.IMAGE_KIND, digest: process.env.IMAGE_DIGEST, runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT, testProfile: process.env.TEST_PROFILE, rulesVersion: process.env.RULES_VERSION });
  if (!process.env.RECEIPT_FILE) throw new Error('image_receipt_output_required');
  writeFileSync(process.env.RECEIPT_FILE, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
}
