import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { ProjectDirectoryDto, ProjectsResponse } from '@ecc/shared';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config/app-config';

const MAX_LISTED_DIRECTORIES = 500;

/**
 * tmux expands formats in the start directory, so `#{...}` or `#(...)` in a directory name would
 * be interpreted rather than taken literally. A trailing `;` would be parsed as a tmux command
 * separator. Control characters have no legitimate place in a project path.
 */
function hasUnsafeCharacters(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[#\x00-\x1f\x7f]/.test(path) || path.endsWith(';');
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

@Injectable()
export class ProjectDirectoriesService {
  constructor(@Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'projectRoots'>) {}

  /** Returns the canonical path, with all symlinks resolved, or throws an ApiError. */
  async resolveWorkingDirectory(input: string): Promise<string> {
    if (!isAbsolute(input) || input.includes('\0')) {
      throw new ApiError(
        400,
        'INVALID_WORKING_DIRECTORY',
        'Working directory must be an absolute path.',
      );
    }

    let canonical: string;
    try {
      canonical = await realpath(input);
    } catch {
      throw new ApiError(400, 'INVALID_WORKING_DIRECTORY', 'Working directory does not exist.');
    }

    const roots = await this.canonicalRoots();
    if (!roots.some((root) => isPathInside(root, canonical))) {
      throw new ApiError(
        403,
        'WORKING_DIRECTORY_NOT_ALLOWED',
        'Working directory is outside the configured project roots.',
      );
    }
    if (!(await stat(canonical)).isDirectory()) {
      throw new ApiError(400, 'INVALID_WORKING_DIRECTORY', 'Working directory is not a directory.');
    }
    if (hasUnsafeCharacters(canonical)) {
      throw new ApiError(
        400,
        'INVALID_WORKING_DIRECTORY',
        'Working directory contains characters that tmux would interpret ("#", control characters, or a trailing ";").',
      );
    }
    return canonical;
  }

  /** The configured roots and their immediate subdirectories, for the session creation dialog. */
  async listProjects(): Promise<ProjectsResponse> {
    const roots = await this.canonicalRoots();
    const directories = new Map<string, ProjectDirectoryDto>();
    for (const root of roots) {
      for (const directory of await this.listChildren(root, roots)) {
        directories.set(directory.path, directory);
      }
    }
    return {
      roots,
      directories: [...directories.values()]
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, MAX_LISTED_DIRECTORIES),
    };
  }

  private async listChildren(root: string, roots: string[]): Promise<ProjectDirectoryDto[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const results = await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith('.'))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map(async (entry) => {
          const path = await realpath(join(root, entry.name)).catch(() => null);
          if (!path || hasUnsafeCharacters(path)) return null;
          if (!roots.some((allowed) => isPathInside(allowed, path))) return null;
          const isDirectory = await stat(path).then(
            (info) => info.isDirectory(),
            () => false,
          );
          return isDirectory ? { name: entry.name, path } : null;
        }),
    );
    return results.filter((result) => result !== null);
  }

  private async canonicalRoots(): Promise<string[]> {
    const roots = await Promise.all(
      this.config.projectRoots.map((root) => realpath(root).catch(() => null)),
    );
    return roots.filter((root) => root !== null);
  }
}
