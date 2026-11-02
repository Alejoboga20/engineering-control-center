/**
 * Strict allowlist for session names managed through the dashboard. It excludes every
 * character tmux gives meaning to in a target or command line (`:`, `.`, `=`, `;`, `#`, `$`, `~`,
 * spaces) and a leading `-`, which tmux would parse as a flag.
 */
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const SESSION_NAME_RULES =
  'Use 1-64 letters, digits, "-" or "_", starting with a letter or digit.';

export function isValidSessionName(name: unknown): name is string {
  return typeof name === 'string' && SESSION_NAME_PATTERN.test(name);
}
