import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../src/inbox/inbox-database';

const SCRIPTS = resolve(__dirname, '../../../scripts');
const MCP = join(SCRIPTS, 'ecc-inbox-mcp.cjs');
const INBOX = join(SCRIPTS, 'inbox.cjs');
const TOKEN = 'mcp-hook-token-0123456789abcdef0123456789';

describe('Inbox MCP server', () => {
  let dir: string;
  let binDir: string;
  let server: Server;
  let received: { headers: IncomingMessage['headers']; body: Record<string, unknown> }[];
  let answer: { status: number; body: unknown };
  let child: ChildProcessWithoutNullStreams;
  let stdout: string;
  let stderr: string;
  /** Responses expected beyond one per request, such as for a line written directly. */
  let extraLines = 0;

  function fakeTmux(answerName: string | null) {
    const script = answerName === null ? 'exit 1' : `echo "${answerName}"`;
    writeFileSync(join(binDir, 'tmux'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  function startMcp(env: Record<string, string | undefined> = {}) {
    stdout = '';
    stderr = '';
    child = spawn(process.execPath, [MCP], {
      cwd: tmpdir(),
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: dir,
        ECC_STATE_DIR: dir,
        ECC_TMUX_SESSION: 'payroll',
        TMUX_PANE: '%3',
        ...env,
      } as NodeJS.ProcessEnv,
    });
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
  }

  /** Sends requests and waits for one response per request with an id. */
  async function rpc(...messages: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const expected = messages.filter((m) => m.id !== undefined).length + extraLines;
    extraLines = 0;
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    const deadline = Date.now() + 5000;
    while (stdout.split('\n').filter(Boolean).length < expected) {
      if (Date.now() > deadline) throw new Error(`Timed out. stdout: ${stdout} stderr: ${stderr}`);
      await new Promise((done) => setTimeout(done, 10));
    }
    const lines = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    stdout = '';
    return lines;
  }

  const call = (name: string, args: Record<string, unknown>, id = 3) =>
    rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ecc-mcp-'));
    binDir = join(dir, 'bin');
    mkdirSync(binDir);
    fakeTmux('payroll');
    received = [];
    answer = { status: 202, body: { itemId: '6f1c1a52-4a8e-4b4e-9b59-1d1f6c1f0d11', created: true } };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
        res.writeHead(answer.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    writeFileSync(
      join(dir, 'claude-hook.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}`, host: 'localhost:4999', token: TOKEN }),
      { mode: 0o600 },
    );
  });

  afterEach(async () => {
    child?.kill();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  it('speaks the MCP handshake and lists only the two reporting tools', async () => {
    startMcp();
    const [init] = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    );
    expect(init).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ecc-inbox', version: '1.0.0' } },
    });
    const [list, ping] = await rpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    );
    const tools = (list.result as { tools: { name: string; inputSchema: { additionalProperties: boolean } }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(['report_blocker', 'report_pull_request']);
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(ping).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });

  it('reports a blocker with the token, the configured Host and the verified session', async () => {
    startMcp();
    const [response] = await call('report_blocker', {
      title: 'Choose a retry strategy',
      description: 'A or B?',
      priority: 'P1',
      idempotency_key: 'retry-strategy-1',
    });
    expect(response.result).toEqual({ content: [{ type: 'text', text: 'Reported to the Engineering Inbox.' }] });
    expect(received).toHaveLength(1);
    expect(received[0].headers).toMatchObject({ host: 'localhost:4999', authorization: `Bearer ${TOKEN}` });
    expect(received[0].body).toEqual({
      type: 'human_input',
      title: 'Choose a retry strategy',
      description: 'A or B?',
      priority: 'P1',
      idempotencyKey: 'retry-strategy-1',
      sourceSession: 'payroll',
    });
    expect(stdout + stderr).not.toContain(TOKEN);
  });

  it('reports with no session when tmux contradicts the claimed one', async () => {
    fakeTmux('other');
    startMcp();
    await call('report_blocker', { title: 'Blocked' });
    expect(received[0].body).not.toHaveProperty('sourceSession');
  });

  it('reports with no session outside tmux', async () => {
    startMcp({ TMUX_PANE: undefined });
    await call('report_blocker', { title: 'Blocked' });
    expect(received[0].body).not.toHaveProperty('sourceSession');
  });

  it('reports a pull request, and explains when GitHub has not confirmed it yet', async () => {
    answer = { status: 202, body: { itemId: null, created: false } };
    startMcp();
    const [response] = await call('report_pull_request', { repository: 'acme/api', number: 7 });
    expect(received[0].body).toEqual({ type: 'pull_request', repository: 'acme/api', pullRequestNumber: 7, sourceSession: 'payroll' });
    expect(JSON.stringify(response.result)).toContain('once GitHub confirms it');
  });

  it.each([
    ['an unknown argument', 'report_blocker', { title: 'x', command: 'rm -rf /' }],
    ['a path argument', 'report_blocker', { title: 'x', path: '/etc/passwd' }],
    ['a missing title', 'report_blocker', {}],
    ['an oversized title', 'report_blocker', { title: 'x'.repeat(201) }],
    ['a bad priority', 'report_blocker', { title: 'x', priority: 'urgent' }],
    ['a malformed repository', 'report_pull_request', { repository: 'acme', number: 1 }],
    ['a path as repository', 'report_pull_request', { repository: '/etc/passwd', number: 1 }],
    ['a non-integer number', 'report_pull_request', { repository: 'acme/api', number: 1.5 }],
    ['an unknown tool', 'approve_permission', {}],
  ])('refuses %s without contacting the backend', async (_name, tool, args) => {
    startMcp();
    const [response] = await call(tool, args);
    expect(response.result).toMatchObject({ isError: true });
    expect(received).toEqual([]);
  });

  it('passes on the backend’s rejection as a tool error', async () => {
    answer = { status: 403, body: { statusCode: 403, code: 'REPOSITORY_NOT_ALLOWED', message: 'acme/secret is not in ECC_GITHUB_REPOS.' } };
    startMcp();
    const [response] = await call('report_pull_request', { repository: 'acme/secret', number: 1 });
    expect(response.result).toEqual({
      content: [{ type: 'text', text: 'The Engineering Inbox rejected the report: acme/secret is not in ECC_GITHUB_REPOS.' }],
      isError: true,
    });
  });

  it('answers a tool error when the backend is unreachable or unconfigured', async () => {
    rmSync(join(dir, 'claude-hook.json'));
    startMcp();
    const [response] = await call('report_blocker', { title: 'x' });
    expect(response.result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/credentials/) }] });
  });

  it('never answers or acts on a notification, whatever its method', async () => {
    startMcp();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'report_blocker', arguments: { title: 'x' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' })}\n`);
    const lines = await rpc({ jsonrpc: '2.0', id: 5, method: 'ping' });
    await new Promise((done) => setTimeout(done, 300));
    expect([...lines, ...stdout.split('\n').filter(Boolean)]).toEqual([{ jsonrpc: '2.0', id: 5, result: {} }]);
    expect(received).toEqual([]);
  });

  it('answers a call in flight before exiting when stdin closes', async () => {
    startMcp();
    const exited = new Promise<number | null>((done) => child.on('close', done));
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'report_blocker', arguments: { title: 'Last words' } } })}\n`);
    expect(await exited).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id: 4, result: { content: [{ text: 'Reported to the Engineering Inbox.' }] } });
  });

  it('answers JSON-RPC errors for malformed input and unknown methods, and keeps running', async () => {
    startMcp();
    child.stdin.write('not json\n');
    extraLines = 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/unknown' })}\n`);
    const lines = await rpc({ jsonrpc: '2.0', id: 9, method: 'resources/list' }, { jsonrpc: '2.0', id: 10, method: 'ping' });
    expect(lines).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'Method not found: resources/list' } },
      { jsonrpc: '2.0', id: 10, result: {} },
    ]);
  });
});

describe('inbox maintenance script', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ecc-inbox-script-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[]) =>
    spawnSync(process.execPath, [INBOX, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, ECC_DATA_DIR: join(dir, 'data') },
    });

  it('backs up the database to a new owner-only file', () => {
    mkdirSync(join(dir, 'data'));
    const db = new Database(join(dir, 'data', 'inbox.sqlite3'));
    db.pragma('journal_mode = WAL');
    migrate(db);
    db.prepare(`INSERT INTO github_sync_state (repository) VALUES ('acme/api')`).run();
    db.close();

    const destination = join(dir, 'backup.sqlite3');
    const result = run(['backup', destination]);
    expect(result.status).toBe(0);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    // A standalone file: no WAL flag, so it opens read-only with no -shm beside it.
    expect(existsSync(`${destination}-wal`) || existsSync(`${destination}-shm`)).toBe(false);
    const header = readFileSync(destination).subarray(18, 20);
    expect([...header]).toEqual([1, 1]);
    const copy = new Database(destination, { readonly: true });
    expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(copy.prepare('SELECT repository FROM github_sync_state').all()).toEqual([{ repository: 'acme/api' }]);
    copy.close();

    expect(run(['backup', destination]).stderr).toMatch(/already exists/);
  });

  it('refuses to back up a database that does not exist', () => {
    const result = run(['backup', join(dir, 'x.sqlite3')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/No Inbox database/);
  });

  it('only prints the MCP commands, with this checkout’s absolute path', () => {
    const result = run(['mcp']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`claude mcp add --scope user ecc-inbox -- ${process.execPath} ${MCP}`);
    expect(result.stdout).toContain('claude mcp remove --scope user ecc-inbox');
  });
});
