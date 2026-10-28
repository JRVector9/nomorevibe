/** Local marker repair after the privileged boundary release has actually committed in the primary DB.
 * This is not terminal/model/usage evidence. The original HTTP receipt stays byte-for-byte intact.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LOCAL_MODEL_RELAY_RECOVERY_LOCK, validRelayRequestId, type RelayReceipt } from './protocol';

export const relayBoundaryProofSchema = z.object({ requestId: z.uuid(), planHash: z.string().regex(/^[a-f0-9]{64}$/),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/), wireHash: z.string().regex(/^[a-f0-9]{64}$/), model: z.string().min(1).max(200),
  releaseEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type RelayBoundaryProof = z.infer<typeof relayBoundaryProofSchema>;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function read(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('relay_recovery_file_invalid');
  return readFileSync(path);
}
function pending(directory: string, requestId: string) {
  if (!validRelayRequestId(requestId)) throw new Error('relay_recovery_request_invalid');
  const activePath = join(directory, 'active.json'), receiptPath = join(directory, `${requestId}.json`);
  const active = read(activePath), marker = JSON.parse(active.toString()) as { requestId?: unknown; relayGeneration?: unknown };
  const bytes = read(receiptPath), receipt = JSON.parse(bytes.toString()) as RelayReceipt;
  if (marker.requestId !== requestId || receipt.requestId !== requestId || !validRelayRequestId(marker.relayGeneration)
    || marker.relayGeneration !== receipt.relayGeneration || receipt.protocol !== 1 || receipt.state !== 'indeterminate'
    || !receipt.endedAt || receipt.terminal !== null) throw new Error('relay_recovery_request_mismatch');
  return { activePath, receiptPath, active, bytes, receipt };
}
/** An in-flight receipt is never cleared. Stop/drain first; this path cannot stop a model or a relay. */
export function checkRelayBoundaryPending(directory: string, requestId: string) {
  if (!existsSync(join(directory, 'active.json'))) {
    if (!existsSync(join(directory, `${requestId}.boundary-release.json`))) throw new Error('relay_recovery_marker_missing');
    return;
  }
  pending(directory, requestId);
}

export function reconcileRelayBoundary(directory: string, value: RelayBoundaryProof): { kind: 'cleared' | 'already_cleared'; requestId: string } {
  const proof = relayBoundaryProofSchema.parse(value), lockPath = join(directory, LOCAL_MODEL_RELAY_RECOVERY_LOCK);
  let lock: number;
  try { lock = openSync(lockPath, 'wx', 0o600); } catch { throw new Error('relay_recovery_locked'); }
  try {
    writeFileSync(lock, JSON.stringify({ requestId: proof.requestId, pid: process.pid }) + '\n', { flush: true });
    return reconcileLocked(directory, proof);
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

function reconcileLocked(directory: string, proof: RelayBoundaryProof): { kind: 'cleared' | 'already_cleared'; requestId: string } {
  const archivePath = join(directory, `${proof.requestId}.boundary-release.json`);
  const activePath = join(directory, 'active.json');
  if (!existsSync(activePath)) {
    const archive = JSON.parse(read(archivePath).toString());
    if (JSON.stringify(archive.proof) !== JSON.stringify(proof)
      || hash(read(join(directory, `${proof.requestId}.json`))) !== archive.receiptHash) throw new Error('relay_recovery_archive_mismatch');
    return { kind: 'already_cleared', requestId: proof.requestId };
  }
  const state = pending(directory, proof.requestId);
  if (state.receipt.requestHash !== proof.wireHash || state.receipt.requestModel !== proof.model)
    throw new Error('relay_recovery_dispatch_mismatch');
  const archive = { version: 1, kind: 'provider_boundary_reconciled', proof, activeHash: hash(state.active), receiptHash: hash(state.bytes) };
  const bytes = JSON.stringify(archive) + '\n';
  if (existsSync(archivePath)) {
    if (!read(archivePath).equals(Buffer.from(bytes))) throw new Error('relay_recovery_archive_mismatch');
  } else writeFileSync(archivePath, bytes, { flag: 'wx', mode: 0o600, flush: true });
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
    // Refuse concurrent changes; keep the durable recovery record for an exact retry.
    if (!read(state.activePath).equals(state.active) || !read(state.receiptPath).equals(state.bytes)) throw new Error('relay_recovery_state_changed');
    unlinkSync(state.activePath); fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  return { kind: 'cleared', requestId: proof.requestId };
}
