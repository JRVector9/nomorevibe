/** Preserve product branding; simplify only an exact repository full-name fallback. */
export function displayProjectName(name: string, repoUrl: string | null): string {
  if (!repoUrl) return name;
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== 'github.com' || !['https:', 'http:'].includes(url.protocol)) return name;
    const path = url.pathname.replace(/^\/|\/$/g, '').replace(/\.git$/i, '');
    const parts = path.split('/');
    if (parts.length !== 2 || !parts.every(Boolean)) return name;
    const trimmed = name.trim();
    return trimmed.toLowerCase() === path.toLowerCase() ? trimmed.split('/')[1] : name;
  } catch { return name; }
}
