export class PublicAuthError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = "PublicAuthError";
  }
}
