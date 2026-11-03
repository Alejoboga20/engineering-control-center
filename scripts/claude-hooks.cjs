#!/usr/bin/env node
'use strict';
/**
 * Installs and removes the dashboard's hooks in the user-level Claude Code settings.
 *
 *   node scripts/claude-hooks.cjs status
 *   node scripts/claude-hooks.cjs install [--dry-run]
 *   node scripts/claude-hooks.cjs uninstall [--dry-run]
 *
 * Every other setting and hook is preserved. The file is backed up before each change. Entries are
 * recognized by the reporter's file name, which is how repeat installs avoid duplicates.
 */
const {
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPORTER_NAME = 'claude-hook-reporter.cjs';
const REPORTER_PATH = path.join(__dirname, REPORTER_NAME);
const HOOK_TIMEOUT_SECONDS = 5;

/** Must match CLAUDE_HOOK_EVENTS in packages/shared. A test keeps the two in step. */
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
];
const TOOL_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
]);

class UsageError extends Error {}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Sessions the dashboard does not monitor cost one shell test and no Node process. The redirect
 * and the unconditional `exit 0` hold even if Node or this repository has moved, so a stale hook
 * can never print into Claude's context or return a blocking exit code.
 */
function hookCommand() {
  const stateDir = process.env.ECC_STATE_DIR;
  const prefix = stateDir ? `ECC_STATE_DIR=${shellQuote(stateDir)} ` : '';
  return (
    `[ -n "$ECC_TMUX_SESSION" ] && ${prefix}${shellQuote(process.execPath)} ` +
    `${shellQuote(REPORTER_PATH)} >/dev/null 2>&1; exit 0`
  );
}

function settingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

function readSettings(file) {
  if (!existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`${file} is not valid JSON, so it was left alone: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`${file} does not contain a JSON object, so it was left alone.`);
  }
  if (parsed.hooks !== undefined && !isHooksObject(parsed.hooks)) {
    throw new UsageError(`"hooks" in ${file} has an unexpected shape, so it was left alone.`);
  }
  return parsed;
}

function isHooksObject(hooks) {
  return (
    hooks !== null &&
    typeof hooks === 'object' &&
    !Array.isArray(hooks) &&
    Object.values(hooks).every(Array.isArray)
  );
}

function isOurs(handler) {
  return typeof handler?.command === 'string' && handler.command.includes(REPORTER_NAME);
}

/** Removes only our handlers, then any group or event that this leaves empty. */
function withoutOurHooks(hooks) {
  const result = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups.flatMap((group) => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(isOurs)) return [group];
      const handlers = group.hooks.filter((handler) => !isOurs(handler));
      return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
    });
    if (kept.length > 0) result[event] = kept;
  }
  return result;
}

function withOurHooks(hooks) {
  const result = withoutOurHooks(hooks);
  const handler = { type: 'command', command: hookCommand(), timeout: HOOK_TIMEOUT_SECONDS };
  for (const event of EVENTS) {
    const group = TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] };
    result[event] = [...(result[event] ?? []), group];
  }
  return result;
}

function installedEvents(hooks) {
  return Object.entries(hooks)
    .filter(([, groups]) => groups.some((group) => group?.hooks?.some(isOurs)))
    .map(([event]) => event);
}

function installedCommands(hooks) {
  return Object.values(hooks).flatMap((groups) =>
    groups.flatMap((group) => (group?.hooks ?? []).filter(isOurs).map((handler) => handler.command)),
  );
}

/** Same contents in a new file, then rename. A settings symlink stays a symlink. */
function writeSettings(file, settings) {
  const target = existsSync(file) ? realpathSync(file) : file;
  const backup = existsSync(target)
    ? `${target}.ecc-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
    : null;
  if (backup) copyFileSync(target, backup);

  const temporary = `${target}.ecc-${process.pid}`;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode, flag: 'wx' });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return backup;
}

function apply(file, settings, hooks, dryRun, log) {
  const next = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  if (dryRun) {
    log('Dry run: nothing was changed.');
    return;
  }
  const backup = writeSettings(file, next);
  if (backup) log(`Backup: ${backup}`);
  log(`Updated: ${file}`);
}

function install(file, settings, dryRun, log) {
  const current = settings.hooks ?? {};
  const hooks = withOurHooks(current);
  const command = hookCommand();
  const upToDate =
    EVENTS.every((event) => installedEvents(current).includes(event)) &&
    installedCommands(current).length === EVENTS.length &&
    installedCommands(current).every((existing) => existing === command);
  if (upToDate) {
    log(`Already installed in ${file}. Nothing to do.`);
    return;
  }
  log(`Hooks for: ${EVENTS.join(', ')}`);
  log(`Command: ${command}`);
  log(`Other hooks already there are kept: ${otherHookCount(current)}`);
  apply(file, settings, hooks, dryRun, log);
  if (!dryRun) log('Restart running Claude Code sessions if they do not start reporting.');
}

function otherHookCount(hooks) {
  return Object.values(withoutOurHooks(hooks))
    .flat()
    .reduce((total, group) => total + (group?.hooks?.length ?? 0), 0);
}

function uninstall(file, settings, dryRun, log) {
  const current = settings.hooks ?? {};
  const events = installedEvents(current);
  if (events.length === 0) {
    log(`Not installed in ${file}. Nothing to do.`);
    return;
  }
  log(`Removing hooks for: ${events.join(', ')}`);
  apply(file, settings, withoutOurHooks(current), dryRun, log);
}

function status(file, settings, log) {
  const hooks = settings.hooks ?? {};
  const events = installedEvents(hooks);
  log(`Settings: ${file}`);
  log(`Installed for: ${events.length > 0 ? events.join(', ') : 'nothing'}`);
  const missing = EVENTS.filter((event) => !events.includes(event));
  if (events.length > 0 && missing.length > 0) log(`Missing: ${missing.join(', ')}`);
  if (events.length > 0 && installedCommands(hooks).some((c) => c !== hookCommand())) {
    log('The installed command differs from this checkout. Run install again to update it.');
  }
  log(`Other hooks: ${otherHookCount(hooks)}`);
}

function main(argv, log = console.log) {
  const [command, ...flags] = argv;
  const unknown = flags.filter((flag) => flag !== '--dry-run');
  if (unknown.length > 0 || !['install', 'uninstall', 'status'].includes(command)) {
    throw new UsageError('Usage: claude-hooks.cjs <install|uninstall|status> [--dry-run]');
  }
  const dryRun = flags.includes('--dry-run');
  const file = settingsPath();
  const settings = readSettings(file);
  if (command === 'install') install(file, settings, dryRun, log);
  else if (command === 'uninstall') uninstall(file, settings, dryRun, log);
  else status(file, settings, log);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(error.message);
  process.exit(1);
}
