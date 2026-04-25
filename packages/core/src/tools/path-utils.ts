import { isAbsolute, relative, resolve } from 'node:path';

export function resolvePathWithinRoot(allowedRoot: string, requestedPath: string): string {
  const resolvedRoot = resolve(allowedRoot);
  const resolvedPath = resolve(resolvedRoot, requestedPath);
  const relativePath = relative(resolvedRoot, resolvedPath);

  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return resolvedPath;
  }

  throw new Error(`Path ${requestedPath} is outside the allowed root ${allowedRoot}`);
}
