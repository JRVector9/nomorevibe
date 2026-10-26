import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// The inspected npm launcher spawns a native child and cannot forward SIGKILL.
// Keep its installed binary, arguments and npm ownership environment, but exec
// that binary so the existing runner's single-PID deadline reaches it directly.
const version = process.argv[2];
assert.equal(version, '0.153.4', 'inspect the npm launcher before changing Codex versions');
assert.equal(process.platform, 'linux', 'this installer is for the worker image');
const entrypoint = '/usr/local/bin/codex';
assert.ok(lstatSync(entrypoint).isSymbolicLink(), 'expected the original npm entrypoint');
const launcher = realpathSync(entrypoint);
const packageRoot = realpathSync(path.join(path.dirname(launcher), '..'));
assert.equal(packageRoot, '/usr/local/lib/node_modules/@openai/codex');
assert.equal(launcher, path.join(packageRoot, 'bin/codex.js'));
assert.equal(createHash('sha256').update(readFileSync(launcher)).digest('hex'),
  '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70',
  'the inspected npm launcher changed');
const metadata = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
assert.equal(metadata.name, '@openai/codex');
assert.equal(metadata.version, version);

const target = {
  x64: ['x86_64-unknown-linux-musl', '@openai/codex-linux-x64'],
  arm64: ['aarch64-unknown-linux-musl', '@openai/codex-linux-arm64'],
}[process.arch];
assert.ok(target, 'unsupported worker architecture');
const [triple, platformPackage] = target;
const require = createRequire(launcher);
let vendorRoot;
try {
  vendorRoot = path.join(path.dirname(require.resolve(`${platformPackage}/package.json`)), 'vendor');
} catch {
  vendorRoot = path.join(packageRoot, 'vendor');
}
const binary = path.join(vendorRoot, triple, 'bin/codex');
assert.ok(existsSync(binary), 'the npm-installed native Codex binary is missing');
accessSync(binary, constants.X_OK);
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), `codex-cli ${version}`);

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
// The pinned npm launcher does not modify PATH. No credential/config variable
// is changed; these are the same managed-install variables it gives its child.
const wrapper = `#!/bin/sh
unset CODEX_MANAGED_BY_NPM CODEX_MANAGED_BY_BUN CODEX_MANAGED_BY_PNPM CODEX_MANAGED_BY_VITE_PLUS
export CODEX_MANAGED_PACKAGE_ROOT=${quote(packageRoot)}
export CODEX_MANAGED_BY_NPM=1
exec ${quote(binary)} "$@"
`;
// Rename over npm's symlink rather than overwriting the inspected package file.
writeFileSync(`${entrypoint}.native-exec`, wrapper, { mode: 0o755, flag: 'wx' });
renameSync(`${entrypoint}.native-exec`, entrypoint);
