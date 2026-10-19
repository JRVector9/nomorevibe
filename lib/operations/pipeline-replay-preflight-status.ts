/** A preflight is executable only for the exact artifact the manifest authorizes. */
export function fixedInputPreflightStatus(expectedSha256: string, actualSha256: string, modelBlocked: readonly string[]) {
  const artifactShaMatches = expectedSha256 === actualSha256;
  const blocked = [...new Set([...(!artifactShaMatches ? ["replay_artifact_sha_mismatch"] : []), ...modelBlocked])];
  return { artifactShaMatches, executable: blocked.length === 0, blocked };
}
