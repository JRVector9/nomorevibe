import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for operator-entered secrets (model API keys) stored in the DB. The key is one infrastructure secret,
 * NMV_SECRET_BOX_KEY (32 bytes, base64), never a model setting. The AAD binds a ciphertext to its owner row identity,
 * so a value copied to another route/model does not open. Without the key nothing can be sealed or opened (fail closed).
 */
type Env = Readonly<Record<string, string | undefined>>;
function boxKey(env: Env): Buffer | null {
  const raw = env.NMV_SECRET_BOX_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}
export const secretBoxReady = (env: Env = process.env) => boxKey(env) !== null;
export function sealSecret(plain: string, aad: string, env: Env = process.env): string {
  const key = boxKey(env);
  if (!key) throw new Error("secret_box_key_missing");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}
export function openSecret(sealed: string, aad: string, env: Env = process.env): string | null {
  const key = boxKey(env), parts = sealed.split(":");
  if (!key || parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
  } catch { return null; }
}
export const servingContractKeyAad = (routeId: string, model: string) => `model_serving_contracts\n${routeId}\n${model}`;
