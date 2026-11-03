import type { ClaudeConfigFileStatus } from '@ecc/shared';

/** Null when the file was read. Parse errors are never shown, as they would quote the file. */
export function fileStatusMessage(status: ClaudeConfigFileStatus): string | null {
  switch (status) {
    case 'ok':
      return null;
    case 'missing':
      return 'Not present.';
    case 'invalid':
      return 'Not valid JSON, so nothing from it is shown.';
    case 'too-large':
      return 'Over the 1 MiB limit, so nothing from it is shown.';
    case 'unreadable':
      return 'The server is not permitted to read this file.';
    case 'unsafe':
      return 'Refused, because it is a symlink to an unapproved target or not a regular file.';
  }
}
