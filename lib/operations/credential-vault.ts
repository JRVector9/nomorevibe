import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
const credentialSchema = z.object({
  auth_mode: z.string().optional(), OPENAI_API_KEY: z.string().nullable().optional(),
  tokens: z.object({ access_token: z.string().min(20), refresh_token: z.string().min(10), id_token: z.string().min(10), account_id: z.string().min(1).optional() }).passthrough(),
}).passthrough();
/** Retain the full CLI contract; never downgrade refresh-capable credentials to an access token. */
export function validateCredential(value: string): string {
  if (Buffer.byteLength(value) > 64 * 1024) throw new Error('invalid_credential');
  credentialSchema.parse(JSON.parse(value)); return value;
}
function key(secret: string) { if (secret.length < 32) throw new Error('vault_secret_required'); return createHash('sha256').update('nomorevibe-vault-v1:'+secret).digest(); }
export function seal(value: string, secret: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  return Buffer.concat([iv, cipher.update(value,'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
export function unseal(value: string, secret: string): string {
  const bytes = Buffer.from(value,'base64'); const decipher = createDecipheriv('aes-256-gcm', key(secret), bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8');
}
export function devicePrompt(output: string): { url?: string; code?: string } {
  const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const code = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0];
  return { ...(clean.includes('https://auth.openai.com/codex/device') ? { url: 'https://auth.openai.com/codex/device' } : {}), ...(code ? { code } : {}) };
}
