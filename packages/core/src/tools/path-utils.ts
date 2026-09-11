import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';

export class PathOutsideRootError extends Error {
  constructor(
    public readonly requestedPath: string,
    public readonly allowedRoot: string,
    public readonly suggestedPath?: string,
  ) {
    super(
      `Path ${requestedPath} is outside the allowed root ${allowedRoot}. ` +
        `Use a workspace-relative path${suggestedPath ? ` such as "${suggestedPath}"` : ''}.`,
    );
    this.name = 'PathOutsideRootError';
  }
}

export function buildWorkspacePathRecovery(
  toolName: string,
  requestedPath: string,
  error: PathOutsideRootError,
): Record<string, string | boolean | null> {
  return {
    ok: false,
    recoveryKind: 'path_outside_workspace',
    toolName,
    requestedPath,
    allowedRoot: error.allowedRoot,
    suggestedPath: error.suggestedPath ?? null,
    message: error.message,
    correctiveAction:
      error.suggestedPath === undefined
        ? 'Retry with a path relative to the workspace root.'
        : `Retry with path "${error.suggestedPath}".`,
  };
}

export function resolvePathWithinRoot(allowedRoot: string, requestedPath: string): string {
  const resolvedRoot = resolve(allowedRoot);
  const expandedPath = expandHomePath(requestedPath);
  const resolvedPath = resolve(resolvedRoot, expandedPath);

  if (isPathWithinRoot(resolvedRoot, resolvedPath)) {
    return resolvedPath;
  }

  const normalizedPath = tryNormalizePathWithinRoot(resolvedRoot, expandedPath);
  if (normalizedPath) {
    return normalizedPath;
  }

  const suggestedPath = buildSuggestedWorkspacePath(resolvedRoot, requestedPath);
  throw new PathOutsideRootError(requestedPath, allowedRoot, suggestedPath);
}

/** Resolve a read path against canonical roots. Relative paths use only the
 * first (workspace) root; absolute paths may belong to any root. `realpath`
 * makes containment resistant to symlink traversal. */
export async function resolvePathWithinRoots(allowedRoots: readonly string[], requestedPath: string): Promise<string> {
  if (allowedRoots.length === 0) {
    throw new TypeError('At least one allowed root is required');
  }
  const resolvedRoots = allowedRoots.map((root) => resolve(root));
  const canonicalRoots = await Promise.all(resolvedRoots.map((root) => realpath(root)));
  if (canonicalRoots.some((root, index) => root !== resolvedRoots[index])) {
    throw new TypeError('Allowed roots must remain canonical paths');
  }
  const expandedPath = expandHomePath(requestedPath);
  let candidate: string;
  if (!isAbsolute(expandedPath)) {
    candidate = resolvePathWithinRoot(canonicalRoots[0]!, expandedPath);
  } else {
    const containingRoot = canonicalRoots.find((root) => isPathWithinRoot(root, resolve(expandedPath)));
    if (containingRoot) {
      candidate = resolve(expandedPath);
    } else {
      // Preserve the established workspace-path recovery for model-generated
      // absolute paths while never rebasing paths into attachment roots.
      candidate = resolvePathWithinRoot(canonicalRoots[0]!, expandedPath);
    }
  }
  const canonicalPath = await realpath(candidate);
  if (canonicalRoots.some((root) => isPathWithinRoot(root, canonicalPath))) {
    return canonicalPath;
  }
  throw new PathOutsideRootError(requestedPath, canonicalRoots[0]!);
}

export function isPathWithinRoot(resolvedRoot: string, resolvedPath: string): boolean {
  const relativePath = relative(resolvedRoot, resolvedPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function expandHomePath(requestedPath: string): string {
  if (requestedPath === '~') {
    return homedir();
  }
  if (requestedPath.startsWith('~/')) {
    return resolve(homedir(), requestedPath.slice(2));
  }
  return requestedPath;
}

function tryNormalizePathWithinRoot(resolvedRoot: string, requestedPath: string): string | undefined {
  if (!isAbsolute(requestedPath)) {
    return undefined;
  }

  const rootName = basename(resolvedRoot);
  const marker = `${sep}${rootName}`;
  const markerIndex = requestedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }

  const markerEnd = markerIndex + marker.length;
  const nextCharacter = requestedPath[markerEnd];
  if (nextCharacter && nextCharacter !== sep) {
    return undefined;
  }

  const suffix = requestedPath.slice(markerEnd).replace(new RegExp(`^\\${sep}+`), '');
  const candidate = resolve(resolvedRoot, suffix);
  return isPathWithinRoot(resolvedRoot, candidate) ? candidate : undefined;
}

function buildSuggestedWorkspacePath(resolvedRoot: string, requestedPath: string): string | undefined {
  if (isAbsolute(requestedPath)) {
    const normalizedCandidate = tryNormalizePathWithinRoot(resolvedRoot, requestedPath);
    if (normalizedCandidate) {
      return relative(resolvedRoot, normalizedCandidate) || '.';
    }

    return basename(requestedPath);
  }

  const resolvedRequestedPath = resolve(resolvedRoot, requestedPath);
  const relativePath = relative(resolvedRoot, resolvedRequestedPath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined;
  }

  return relativePath;
}
