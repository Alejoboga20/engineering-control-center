#!/usr/bin/env node
'use strict';
/**
 * Claude Code hook adapter. Reads the hook JSON on stdin and reports lifecycle metadata to the
 * dashboard. Monitoring is best-effort: this always exits 0 and prints nothing, because stdout
 * from a hook can become Claude's context or a decision, and exit code 2 can block Claude.
 *
 * Only the fields named in buildPayload ever leave this process. Prompts, tool arguments, tool
 * output, transcript paths and environment contents are never read out of the input.
 */
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { claimedSession, mappingContradicted, readCredentials } = require('./ecc-local.cjs');

/** Must match CLAUDE_HOOK_EVENTS in packages/shared. A test keeps the two in step. */
const EVENTS = new Set([
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
]);

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

const OVERALL_LIMIT_MS = 1500;
const NETWORK_TIMEOUT_MS = 500;
/** PostToolUse carries the tool's whole output, which can be large. Larger input is dropped. */
const MAX_STDIN_BYTES = 32 * 1024 * 1024;

function done() {
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) reject(new Error('too large'));
      else chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function optional(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function buildPayload(input, tmuxSession, pane, timestamp) {
  if (!input || typeof input !== 'object') return null;
  if (!EVENTS.has(input.hook_event_name)) return null;
  const claudeSessionId = optional(input.session_id, IDENTIFIER);
  if (!claudeSessionId) return null;
  return {
    eventId: randomUUID(),
    claudeSessionId,
    tmuxSession,
    eventType: input.hook_event_name,
    timestamp,
    pane,
    source: optional(input.source, IDENTIFIER),
    notificationType: optional(input.notification_type, IDENTIFIER),
    toolName: optional(input.tool_name, TOOL_NAME),
    agentId: optional(input.agent_id, IDENTIFIER),
  };
}

function send({ url, host, token }, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      url,
      {
        method: 'POST',
        agent: false,
        timeout: NETWORK_TIMEOUT_MS,
        headers: {
          Host: host,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.on('end', resolve);
        response.on('error', resolve);
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', resolve);
    request.end(body);
  });
}

async function main() {
  const timestamp = new Date().toISOString();
  // No claim, or a claim made outside tmux: there is no reliable mapping to report.
  const claim = claimedSession();
  if (!claim) return;
  const { tmuxSession, pane } = claim;

  const payload = buildPayload(JSON.parse(await readStdin()), tmuxSession, pane, timestamp);
  if (!payload) return;
  if (await mappingContradicted(tmuxSession, pane)) return;
  const { url, host, token } = readCredentials();
  await send({ url: new URL('/api/claude/hooks', url), host, token }, payload);
}

// A stalled stdin, tmux or backend must not hold Claude Code up.
setTimeout(done, OVERALL_LIMIT_MS);
process.on('uncaughtException', done);
process.on('unhandledRejection', done);
main().then(done, done);
