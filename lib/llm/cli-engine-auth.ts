import { createHmac, timingSafeEqual } from 'node:crypto';

import { CLI_ENGINE_AUTH_PREFIX } from './cli-engine-config';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export function cliEngineBearer(secret: string): string {
  if (
    typeof secret !== 'string' ||
    secret.length < 32 ||
    secret.length > 4096 ||
    CONTROL_CHARACTER_PATTERN.test(secret)
  ) {
    throw new Error('invalid_cli_engine_secret');
  }

  const token = createHmac('sha256', secret)
    .update('nmv-cli-engine-v1')
    .digest('hex');

  return CLI_ENGINE_AUTH_PREFIX + token;
}

export function cliEngineProofKey(bearer: string): string {
  if (typeof bearer !== 'string' || !bearer.startsWith(CLI_ENGINE_AUTH_PREFIX)) {
    throw new Error('invalid_cli_engine_auth');
  }

  const token = bearer.slice(CLI_ENGINE_AUTH_PREFIX.length);
  if (!SHA256_HEX_PATTERN.test(token)) {
    throw new Error('invalid_cli_engine_auth');
  }

  return token;
}

export function cliEngineSign(value: string, bearer: string): string {
  const token = cliEngineProofKey(bearer);
  return createHmac('sha256', Buffer.from(token, 'hex'))
    .update('nmv-cli-engine-terminal-v1\n' + value)
    .digest('hex');
}

export function cliEngineSignatureMatches(
  value: string,
  bearer: string,
  signature: string,
): boolean {
  if (typeof signature !== 'string' || !SHA256_HEX_PATTERN.test(signature)) {
    return false;
  }

  const expected = Buffer.from(cliEngineSign(value, bearer), 'hex');
  const actual = Buffer.from(signature, 'hex');

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
