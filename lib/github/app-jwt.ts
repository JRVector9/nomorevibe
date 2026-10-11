import { createPrivateKey, createSign } from "node:crypto";

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** RS256 App JWT: start one minute early and expire nine minutes after signing. */
export function appJwt(appId: number, privateKeyPem: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(createPrivateKey(privateKeyPem)))}`;
}
