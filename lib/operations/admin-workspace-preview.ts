/** Explicit opt-in for the private real-data design preview; normal app behavior is unchanged. */
export function adminWorkspaceReadOnly(): boolean {
  return process.env.ADMIN_WORKSPACE_PREVIEW_READ_ONLY === "1";
}
