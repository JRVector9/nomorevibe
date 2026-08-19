import { createHash } from "node:crypto";

export class MakerResourceVersionMismatchError extends Error {
  constructor() {
    super("maker resource version mismatch");
    this.name = "MakerResourceVersionMismatchError";
  }
}

export function makerResourceEtag(value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return `"${digest}"`;
}

export function assertMakerResourceVersion(expected: string | undefined, value: unknown): void {
  if (expected !== undefined && expected !== makerResourceEtag(value)) {
    throw new MakerResourceVersionMismatchError();
  }
}
