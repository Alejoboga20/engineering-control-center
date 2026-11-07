#!/usr/bin/env node
'use strict';
/**
 * Local MCP server (stdio) that lets a Claude Code agent report to the Engineering Inbox.
 *
 *   claude mcp add --scope user ecc-inbox -- node /abs/path/scripts/ecc-inbox-mcp.cjs
 *
 * Newline-delimited JSON-RPC 2.0 on stdin and stdout; nothing else is ever written to stdout.
 * It can only report: a blocker that needs a person, or a pull request the agent opened. It
 * never accepts paths or commands, cannot resolve, approve or merge anything, and never prints
 * the token. The tmux session is the one tmux confirms for this pane, or none.
 */
const http = require('node:http');
const readline = require('node:readline');
const { readCredentials, verifiedSession } = require('./ecc-local.cjs');

const SERVER_INFO = { name: 'ecc-inbox', version: '1.0.0' };
/** Answered as requested when known, otherwise the newest one listed here. */
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const REQUEST_TIMEOUT_MS = 10_000;
/** Unlike a hook, a tool call can afford to wait for tmux. */
const TMUX_TIMEOUT_MS = 2000;
const MAX_LINE_BYTES = 64 * 1024;

const LIMITS = {
  titleMax: 200,
  descriptionMax: 4000,
  idempotencyKey: /^[A-Za-z0-9_.:-]{8,128}$/,
  repository: /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/,
};

const TOOLS = [
  {
    name: 'report_blocker',
    description:
      'Tell the human, through the Engineering Inbox, that you are blocked and need a decision or ' +
      'input. Use a short, specific title. Retrying with the same idempotency_key never creates a ' +
      'duplicate. Do not include secrets, file contents or command output.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: LIMITS.titleMax, description: 'One line.' },
        description: { type: 'string', maxLength: LIMITS.descriptionMax, description: 'Plain text.' },
        priority: { type: 'string', enum: ['P1', 'P2', 'P3'], description: 'P1 when work is blocked. Default P2.' },
        idempotency_key: {
          type: 'string',
          pattern: LIMITS.idempotencyKey.source,
          description: 'Optional. The same key identifies the same report.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_pull_request',
    description:
      'Tell the Engineering Inbox that you opened a pull request. GitHub stays the source of truth: ' +
      'the Inbox confirms the pull request with GitHub before showing it.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', pattern: LIMITS.repository.source, description: 'owner/name' },
        number: { type: 'integer', minimum: 1 },
      },
      required: ['repository', 'number'],
      additionalProperties: false,
    },
  },
];

class ToolInputError extends Error {}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function text(message, isError = false) {
  return { content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) };
}

function onlyKeys(args, allowed) {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new ToolInputError(`Unknown argument: ${extra.join(', ')}.`);
}

function optionalString(args, key, max) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new ToolInputError(`${key} must be a string of at most ${max} characters.`);
  }
  return value;
}

function blockerReport(args) {
  onlyKeys(args, ['title', 'description', 'priority', 'idempotency_key']);
  const title = optionalString(args, 'title', LIMITS.titleMax);
  if (!title || !title.trim()) throw new ToolInputError('title is required.');
  const priority = args.priority;
  if (priority !== undefined && !['P1', 'P2', 'P3'].includes(priority)) {
    throw new ToolInputError('priority must be P1, P2 or P3.');
  }
  const key = args.idempotency_key;
  if (key !== undefined && (typeof key !== 'string' || !LIMITS.idempotencyKey.test(key))) {
    throw new ToolInputError('idempotency_key must be 8-128 of A-Z a-z 0-9 _ . : -');
  }
  return {
    type: 'human_input',
    title,
    description: optionalString(args, 'description', LIMITS.descriptionMax),
    priority,
    idempotencyKey: key,
  };
}

function pullRequestReport(args) {
  onlyKeys(args, ['repository', 'number']);
  if (typeof args.repository !== 'string' || !LIMITS.repository.test(args.repository)) {
    throw new ToolInputError('repository must look like owner/name.');
  }
  if (!Number.isInteger(args.number) || args.number < 1) {
    throw new ToolInputError('number must be a positive integer.');
  }
  return { type: 'pull_request', repository: args.repository, pullRequestNumber: args.number };
}

function post(body) {
  let credentials;
  try {
    credentials = readCredentials();
  } catch {
    return Promise.reject(new Error('Engineering Control Center credentials were not found.'));
  }
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      new URL('/api/inbox/events/agent', credentials.url),
      {
        method: 'POST',
        agent: false,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Host: credentials.host,
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Reported as a status below.
          }
          resolve({ status: response.statusCode, body: parsed });
        });
        response.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error('Engineering Control Center did not answer in time.')));
    request.on('error', () => reject(new Error('Engineering Control Center is not reachable.')));
    request.end(payload);
  });
}

function describeResult(report, { status, body }) {
  if (status === 202 && body) {
    if (report.type === 'pull_request' && body.itemId === null) {
      return text('Recorded. The Inbox will show the pull request once GitHub confirms it.');
    }
    return text(body.created ? 'Reported to the Engineering Inbox.' : 'Already in the Engineering Inbox; updated.');
  }
  const reason = body && typeof body.message === 'string' ? body.message.slice(0, 300) : `status ${status}`;
  return text(`The Engineering Inbox rejected the report: ${reason}`, true);
}

async function callTool(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (typeof args !== 'object' || Array.isArray(args)) return text('arguments must be an object.', true);
  let report;
  try {
    if (name === 'report_blocker') report = blockerReport(args);
    else if (name === 'report_pull_request') report = pullRequestReport(args);
    else return text(`Unknown tool: ${String(name).slice(0, 64)}`, true);
  } catch (error) {
    if (error instanceof ToolInputError) return text(error.message, true);
    throw error;
  }
  // Without a session that tmux confirms, the report goes out with none rather than a guess.
  const sourceSession = await verifiedSession(TMUX_TIMEOUT_MS);
  if (sourceSession) report.sourceSession = sourceSession;
  try {
    return describeResult(report, await post(report));
  } catch (error) {
    return text(error.message, true);
  }
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message && message.id !== undefined) fail(message.id, -32600, 'Invalid request');
    return;
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case 'ping':
      if (!isNotification) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call':
      reply(id, await callTool(params));
      return;
    default:
      if (!isNotification) fail(id, -32601, `Method not found: ${method.slice(0, 64)}`);
  }
}

const inFlight = new Set();
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    fail(null, -32600, 'Request too large');
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Parse error');
    return;
  }
  const pending = handle(message).catch(() => {
    if (message && message.id !== undefined) fail(message.id, -32603, 'Internal error');
  });
  inFlight.add(pending);
  pending.finally(() => inFlight.delete(pending));
});
// Calls still in flight are answered before exiting.
lines.on('close', () => Promise.allSettled([...inFlight]).then(() => process.exit(0)));
