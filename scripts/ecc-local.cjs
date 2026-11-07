'use strict';
/**
 * What the hook reporter and the Inbox MCP server share: how they find the backend, and how they
 * decide which tmux session they run in. Dependency-free, like both of its users.
 */
const { execFile } = require('node:child_process');
const { readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PANE = /^%\d{1,10}$/;
const TMUX_TIMEOUT_MS = 500;

/** The backend's URL, an accepted Host header and the bearer token, from the private file. */
function readCredentials() {
  const dir =
    process.env.ECC_STATE_DIR || path.join(os.homedir(), '.config', 'engineering-control-center');
  const { url, host, token } = JSON.parse(readFileSync(path.join(dir, 'claude-hook.json'), 'utf8'));
  return { url, host, token };
}

/**
 * The tmux session claimed by ECC_TMUX_SESSION and the pane in TMUX_PANE, or null when either is
 * missing or malformed, which means no reliable mapping exists.
 */
function claimedSession() {
  const tmuxSession = process.env.ECC_TMUX_SESSION;
  const pane = process.env.TMUX_PANE;
  if (!tmuxSession || !SESSION_NAME.test(tmuxSession) || !pane || !PANE.test(pane)) return null;
  return { tmuxSession, pane };
}

/**
 * The variable is inherited, so it can outlive the truth: after `tmux rename-session`, or inside a
 * nested tmux. tmux itself says which session this pane belongs to, and a disagreement means the
 * mapping is unreliable. If tmux cannot answer, the variable stands.
 */
function mappingContradicted(tmuxSession, pane, timeoutMs = TMUX_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      ['display-message', '-p', '-t', pane, '#{session_name}'],
      { timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout) => {
        const actual = error ? '' : stdout.trim();
        resolve(actual !== '' && actual !== tmuxSession);
      },
    );
  });
}

/** The verified tmux session name, or null. Never a guess. */
async function verifiedSession(timeoutMs) {
  const claim = claimedSession();
  if (!claim) return null;
  return (await mappingContradicted(claim.tmuxSession, claim.pane, timeoutMs)) ? null : claim.tmuxSession;
}

module.exports = { SESSION_NAME, PANE, readCredentials, claimedSession, mappingContradicted, verifiedSession };
