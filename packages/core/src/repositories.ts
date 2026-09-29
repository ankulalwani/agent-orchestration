/**
 * Repository identity, shared by the control plane and workers. A repository is known by a key that
 * is the same wherever it is cloned:
 * - `<host>/<owner>/<name>` (lower case) for repositories with a remote, from any https, ssh or
 *   scp-style URL of it;
 * - `local:<root commit>` for repositories without a remote that have at least one commit.
 */

/** Host (without port) and repository path of a remote, from https, ssh or scp-style URLs. */
function remoteIdentity(url: string): { host: string; path: string } | null {
  const trimmed = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scp && !trimmed.includes('://')) return { host: scp[1]!.toLowerCase(), path: scp[2]! };
  try {
    const u = new URL(trimmed);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return null;
    const p = u.pathname.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '');
    // ssh://git@host:22/... keeps the port out of the identity: the same repository over https has none.
    return p ? { host: u.hostname.toLowerCase(), path: p } : null;
  } catch {
    return null;
  }
}

/** Identity key of a remote URL, or null when it is not a recognisable remote. */
export function repositoryKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const r = remoteIdentity(url);
  return r ? `${r.host}/${r.path}`.toLowerCase() : null;
}

/** Identity key of a repository without a remote, from its root commit. */
export function localRepositoryKey(rootCommit: string): string {
  return `local:${rootCommit.toLowerCase()}`;
}

/**
 * Folder-safe, human-readable repository name: the last path segment of a remote, else the given
 * fallback. Used as the repository's name inside a project and as the default clone folder.
 */
export function repositoryName(urlOrKey: string | null | undefined, fallback = 'repository'): string {
  const key = urlOrKey ? (repositoryKey(urlOrKey) ?? urlOrKey) : '';
  const last = key.startsWith('local:') ? '' : (key.split('/').pop() ?? '');
  return sanitizeRepositoryName(last || fallback);
}

export function sanitizeRepositoryName(name: string): string {
  const clean = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100);
  return clean || 'repository';
}
