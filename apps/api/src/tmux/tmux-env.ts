const INHERITED = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMUX_TMPDIR',
  'XDG_RUNTIME_DIR',
];

/**
 * Environment for tmux and for the attach PTY. It is an allowlist because a tmux server started
 * by the dashboard hands its environment to every shell it spawns, so dashboard configuration
 * must not leak into sessions. TMUX is deliberately absent: when the backend itself runs inside
 * tmux, `attach-session` would otherwise refuse to nest.
 */
export function buildTmuxEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED) {
    const value = source[key];
    if (value) env[key] = value;
  }
  env.LANG ??= 'C.UTF-8';
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}
