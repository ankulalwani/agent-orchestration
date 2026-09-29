import path from 'node:path';
import fs from 'node:fs';
import { AppError } from './errors.js';

/**
 * Project path isolation (spec §58, §114, §115).
 * Resolves `target` relative to `root` and rejects anything that escapes the root, including via
 * `..`, absolute paths, drive-letter switches, and symlinks that point outside.
 */
export function resolveWithinRoot(root: string, target: string, opts: { followSymlinks?: boolean } = {}): string {
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(rootAbs, target);
  assertInside(rootAbs, resolved, target);
  if (opts.followSymlinks !== false && fs.existsSync(resolved)) {
    const real = fs.realpathSync.native(resolved);
    const realRoot = fs.realpathSync.native(rootAbs);
    assertInside(realRoot, real, target);
  }
  return resolved;
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertInside(root: string, candidate: string, original: string) {
  if (!isInside(root, candidate)) {
    throw new AppError('PATH_OUTSIDE_PROJECT', 'Path is outside the project directory', {
      context: { path: original },
    });
  }
}
