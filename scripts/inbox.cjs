#!/usr/bin/env node
'use strict';
/**
 * Engineering Inbox maintenance.
 *
 *   node scripts/inbox.cjs backup <destination>   consistent copy, safe while the dashboard runs
 *   node scripts/inbox.cjs mcp                    prints the commands that add or remove the MCP server
 *
 * Nothing here changes the live database or Claude Code configuration.
 */
const { chmodSync, existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATABASE_FILE = 'inbox.sqlite3';
const MCP_SCRIPT = path.join(__dirname, 'ecc-inbox-mcp.cjs');

class UsageError extends Error {}

function databasePath() {
  const dir = process.env.ECC_DATA_DIR
    ? path.resolve(process.env.ECC_DATA_DIR.replace(/^~(?=$|\/)/, os.homedir()))
    : path.join(os.homedir(), '.local', 'share', 'engineering-control-center');
  return path.join(dir, DATABASE_FILE);
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** better-sqlite3 is a dependency of the API package, so it is resolved from there. */
function openDatabase(file) {
  const Database = require(require.resolve('better-sqlite3', { paths: [path.join(__dirname, '../apps/api')] }));
  return new Database(file, { readonly: true, fileMustExist: true });
}

/** SQLite's online backup API: a consistent snapshot even while the dashboard writes. */
async function backup(destination, log) {
  if (!destination) throw new UsageError('Usage: inbox.cjs backup <destination>');
  const source = databasePath();
  if (!existsSync(source)) throw new UsageError(`No Inbox database at ${source}. Is ECC_DATA_DIR set?`);
  const target = path.resolve(destination);
  if (existsSync(target)) throw new UsageError(`${target} already exists. Choose a new file.`);
  const db = openDatabase(source);
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
  chmodSync(target, 0o600);
  log(`Backed up ${source} to ${target}`);
}

function mcp(log) {
  const command = `${shellQuote(process.execPath)} ${shellQuote(MCP_SCRIPT)}`;
  log('Nothing has been changed. To let Claude Code agents report to the Inbox, run:');
  log('');
  log(`  claude mcp add --scope user ecc-inbox -- ${command}`);
  log('');
  log('To remove it again:');
  log('');
  log('  claude mcp remove --scope user ecc-inbox');
  if (process.env.ECC_STATE_DIR) {
    log('');
    log(`ECC_STATE_DIR is set. Add --env ECC_STATE_DIR=${shellQuote(process.env.ECC_STATE_DIR)} before ecc-inbox.`);
  }
}

async function main(argv, log = console.log) {
  const [command, ...rest] = argv;
  if (command === 'backup' && rest.length <= 1) return backup(rest[0], log);
  if (command === 'mcp' && rest.length === 0) return mcp(log);
  throw new UsageError('Usage: inbox.cjs <backup <destination> | mcp>');
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof UsageError ? error.message : `Failed: ${error.message}`);
  process.exit(1);
});
