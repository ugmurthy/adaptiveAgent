import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

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
  const resolvedPath = resolve(resolvedRoot, requestedPath);

  if (isPathWithinRoot(resolvedRoot, resolvedPath)) {
    return resolvedPath;
  }

  const normalizedPath = tryNormalizePathWithinRoot(resolvedRoot, requestedPath);
  if (normalizedPath) {
    return normalizedPath;
  }

  const suggestedPath = buildSuggestedWorkspacePath(resolvedRoot, requestedPath);
  throw new PathOutsideRootError(requestedPath, allowedRoot, suggestedPath);
}

function isPathWithinRoot(resolvedRoot: string, resolvedPath: string): boolean {
  const relativePath = relative(resolvedRoot, resolvedPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
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
