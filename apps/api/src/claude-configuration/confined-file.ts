import { constants } from 'node:fs';
import { FileHandle, open, realpath, stat } from 'node:fs/promises';

/** O_NONBLOCK keeps a FIFO placed in a configuration directory from hanging the request. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export type ConfinedRead =
  | { status: 'ok'; text: string; modifiedAt: string }
  | { status: 'missing' | 'too-large' | 'unreadable' | 'unsafe' };

function classifyOpenError(error: unknown): ConfinedRead {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' };
  if (code === 'ELOOP' || code === 'EMLINK' || code === 'ENXIO') return { status: 'unsafe' };
  return { status: 'unreadable' };
}

/** Confirms that the opened file is still the one at this canonical path. */
async function isSameFile(handle: FileHandle, canonicalPath: string): Promise<boolean> {
  const [opened, resolved] = await Promise.all([handle.stat(), realpath(canonicalPath)]);
  if (resolved !== canonicalPath) return false;
  const current = await stat(canonicalPath);
  return current.dev === opened.dev && current.ino === opened.ino;
}

/**
 * Reads a path already validated by discovery. A link swapped in afterwards is refused: the last
 * component by O_NOFOLLOW, and parent directories by resolving the path again after opening.
 * Reads at most `readBytes`, so listing never loads a whole body.
 */
export async function readConfinedFile(
  canonicalPath: string,
  limits: { maxFileBytes: number; readBytes?: number },
): Promise<ConfinedRead> {
  let handle: FileHandle;
  try {
    handle = await open(canonicalPath, OPEN_FLAGS);
  } catch (error) {
    return classifyOpenError(error);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: 'unsafe' };
    if (info.size > limits.maxFileBytes) return { status: 'too-large' };
    if (!(await isSameFile(handle, canonicalPath))) return { status: 'unsafe' };

    const buffer = Buffer.alloc(Math.min(info.size, limits.readBytes ?? limits.maxFileBytes));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const content = buffer.subarray(0, length);
    if (content.includes(0)) return { status: 'unsafe' };
    return { status: 'ok', text: content.toString('utf8'), modifiedAt: info.mtime.toISOString() };
  } catch {
    return { status: 'unreadable' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
