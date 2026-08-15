import { createHash, randomBytes } from "node:crypto";

export function generateEditToken(): string {
  return `nmv_edit_${randomBytes(24).toString("hex")}`;
}

export function generateVerifyToken(): string {
  return `nmv_verify_${randomBytes(16).toString("hex")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
