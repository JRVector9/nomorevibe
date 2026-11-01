/** A short cache hint, never an authentication or authorization credential. */
export const RENDER_RECOVERY_COOKIE = "nmv_render_recovery";
export const RENDER_RECOVERY_COOKIE_VALUE = "1";
export const RENDER_RECOVERY_COOKIE_MAX_AGE = 20;

export function renderRecoveryCookie(secure: boolean): string {
  return `${RENDER_RECOVERY_COOKIE}=${RENDER_RECOVERY_COOKIE_VALUE}; Path=/; Max-Age=${RENDER_RECOVERY_COOKIE_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}
