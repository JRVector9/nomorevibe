/** Relay marker release after the declared engine hard deadline (+ skew) has elapsed since the request started.
 * The engine bound is an operator declaration (serving contract `provider_hard_deadline`), never a relay timer.
 * This only re-opens the relay. It is not DB release, model-terminal, usage or business evidence; the original
 * indeterminate receipt stays byte-for-byte intact.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_MODEL_RELAY_DEADLINE_RELEASE_SUFFIX, LOCAL_MODEL_RELAY_RECOVERY_LOCK, validRelayRequestId, type RelayReceipt } from './protocol';

export type RelayDeadlinePolicy = Readonly<{ engineDeadlineMs: number; skewMs: number }>;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function read(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('relay_recovery_file_invalid');
  return readFileSync(path);
}

/** The indeterminate receipt named by active.json, or null. In-flight or mismatched state is never released. */
export function pendingIndeterminateReceipt(directory: string): RelayReceipt | null {
  const activePath = join(directory, 'active.json');
  if (!existsSync(activePath)) return null;
  const marker = JSON.parse(read(activePath).toString()) as { requestId?: unknown; relayGeneration?: unknown };
  if (!validRelayRequestId(marker.requestId)) return null;
  const receiptPath = join(directory, `${marker.requestId}.json`);
  if (!existsSync(receiptPath)) return null;
  const receipt = JSON.parse(read(receiptPath).toString()) as RelayReceipt;
  return receipt.requestId === marker.requestId && receipt.relayGeneration === marker.relayGeneration && receipt.protocol === 1
    && receipt.state === 'indeterminate' && receipt.endedAt !== null && receipt.terminal === null ? receipt : null;
}

/** Earliest time the engine must have stopped: request start (before forwarding) + declared bound + skew. */
export function relayDeadlineNotBefore(receipt: Pick<RelayReceipt, 'startedAt'>, policy: RelayDeadlinePolicy): number {
  const started = Date.parse(receipt.startedAt);
  if (!Number.isFinite(started)) throw new Error('relay_deadline_start_invalid');
  return started + policy.engineDeadlineMs + policy.skewMs;
}

export function releaseRelayAfterEngineDeadline(directory: string, requestId: string, policy: RelayDeadlinePolicy, nowMs = Date.now()):
  { kind: 'released' | 'already_released'; requestId: string } | { kind: 'waiting'; requestId: string; notBeforeMs: number } {
  if (!validRelayRequestId(requestId)) throw new Error('relay_recovery_request_invalid');
  const lockPath = join(directory, LOCAL_MODEL_RELAY_RECOVERY_LOCK);
  let lock: number;
  try { lock = openSync(lockPath, 'wx', 0o600); } catch { throw new Error('relay_recovery_locked'); }
  try {
    writeFileSync(lock, JSON.stringify({ requestId, pid: process.pid, kind: 'engine_deadline' }) + '\n', { flush: true });
    const archivePath = join(directory, `${requestId}${LOCAL_MODEL_RELAY_DEADLINE_RELEASE_SUFFIX}`);
    const activePath = join(directory, 'active.json'), receiptPath = join(directory, `${requestId}.json`);
    if (!existsSync(activePath)) {
      if (!existsSync(archivePath)) throw new Error('relay_recovery_marker_missing');
      return { kind: 'already_released', requestId };
    }
    const receipt = pendingIndeterminateReceipt(directory);
    if (!receipt || receipt.requestId !== requestId) throw new Error('relay_recovery_request_mismatch');
    const notBeforeMs = relayDeadlineNotBefore(receipt, policy);
    if (nowMs < notBeforeMs) return { kind: 'waiting', requestId, notBeforeMs };
    const active = read(activePath), bytes = read(receiptPath);
    const archive = { version: 1, kind: 'engine_deadline_elapsed', requestId, startedAt: receipt.startedAt, endedAt: receipt.endedAt,
      error: receipt.error, engineDeadlineMs: policy.engineDeadlineMs, skewMs: policy.skewMs,
      notBefore: new Date(notBeforeMs).toISOString(), evaluatedAt: new Date(nowMs).toISOString(), activeHash: hash(active), receiptHash: hash(bytes) };
    if (!existsSync(archivePath)) writeFileSync(archivePath, JSON.stringify(archive) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    const descriptor = openSync(directory, 'r');
    try {
      fsyncSync(descriptor);
      if (!read(activePath).equals(active) || !read(receiptPath).equals(bytes)) throw new Error('relay_recovery_state_changed');
      unlinkSync(activePath); fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    return { kind: 'released', requestId };
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
