import os from 'os';
import path from 'path';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUUID(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Allowed base directories for repo paths.
 * Set ALLOWED_REPO_BASES env var as colon-separated list to override.
 * Defaults to the user's home directory.
 */
function getAllowedRepoBases(): string[] {
  const env = (process.env.ALLOWED_REPO_BASES || '').trim();
  if (env) {
    return env.split(':').map(p => path.resolve(p));
  }
  return [os.homedir()];
}

/**
 * Check that a repo path is under one of the allowed base directories.
 * Uses path.resolve to normalize and prevent traversal (e.g. /home/user/../root).
 */
export function isAllowedRepoPath(repoPath: string): boolean {
  const resolved = path.resolve(repoPath);
  return getAllowedRepoBases().some(base =>
    resolved === base || resolved.startsWith(base + '/')
  );
}
