import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLAUDE_HOOK_EVENTS } from '@ecc/shared';

const SCRIPTS = resolve(__dirname, '../../../scripts');
const REPORTER = join(SCRIPTS, 'claude-hook-reporter.cjs');
const INSTALLER = join(SCRIPTS, 'claude-hooks.cjs');

const SECRETS = {
  prompt: 'SECRET-PROMPT',
  tool_input: { command: 'cat SECRET-ARGUMENT' },
  tool_response: { stdout: 'SECRET-OUTPUT' },
  transcript_path: '/home/dev/SECRET-TRANSCRIPT.jsonl',
  cwd: '/home/dev/SECRET-CWD',
  last_assistant_message: 'SECRET-ASSISTANT',
  message: 'SECRET-NOTIFICATION',
};

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

describe('hook reporter', () => {
  let dir: string;
  let server: Server | null;
  let received: { headers: IncomingMessage['headers']; body: string }[];
  let binDir: string;

  /** A stand-in for tmux that answers with the given session name, or fails. */
  function fakeTmux(answer: string | null) {
    const script = answer === null ? 'exit 1' : `echo "${answer}"`;
    writeFileSync(join(binDir, 'tmux'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  function writeCredentials(port: number) {
    writeFileSync(
      join(dir, 'claude-hook.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}`, host: 'localhost:4999', token: 'hook-token' }),
    );
  }

  async function startBackend(respond = true): Promise<number> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
        if (respond) res.writeHead(202).end('{}');
      });
    });
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    writeCredentials(port);
    return port;
  }

  function runReporter(stdin: string, env: Record<string, string | undefined> = {}): Promise<Result> {
    return new Promise((done) => {
      const started = Date.now();
      const child = spawn(process.execPath, [REPORTER], {
        cwd: tmpdir(),
        env: {
          PATH: `${binDir}:${process.env.PATH}`,
          HOME: dir,
          ECC_STATE_DIR: dir,
          ECC_TMUX_SESSION: 'payroll',
          TMUX_PANE: '%3',
          SECRET_API_KEY: 'SECRET-ENV',
          ...env,
        } as NodeJS.ProcessEnv,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (code) => done({ code, stdout, stderr, ms: Date.now() - started }));
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    });
  }

  const hook = (fields: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: 'claude-1',
      hook_event_name: 'UserPromptSubmit',
      ...SECRETS,
      ...fields,
    });

  function expectSilentSuccess(result: Result) {
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ecc-reporter-'));
    binDir = join(dir, 'bin');
    mkdirSync(binDir);
    fakeTmux('payroll');
    received = [];
    server = null;
  });

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((done) => (server ? server.close(done) : done(undefined)));
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends normalized metadata with the token and the configured Host', async () => {
    await startBackend();
    expectSilentSuccess(await runReporter(hook({ tool_name: 'Bash', agent_id: 'sub-1' })));
    expect(received).toHaveLength(1);
    expect(received[0].headers).toMatchObject({
      host: 'localhost:4999',
      authorization: 'Bearer hook-token',
    });
    const body = JSON.parse(received[0].body);
    expect(body).toEqual({
      eventId: expect.any(String),
      claudeSessionId: 'claude-1',
      tmuxSession: 'payroll',
      eventType: 'UserPromptSubmit',
      timestamp: expect.any(String),
      pane: '%3',
      toolName: 'Bash',
      agentId: 'sub-1',
    });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('never transmits content, whatever the input contains', async () => {
    await startBackend();
    await runReporter(hook());
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0])).not.toContain('SECRET');
  });

  it('passes on notification type and session source, which carry no content', async () => {
    await startBackend();
    await runReporter(hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }));
    await runReporter(hook({ hook_event_name: 'SessionStart', source: 'startup' }));
    expect(JSON.parse(received[0].body).notificationType).toBe('idle_prompt');
    expect(JSON.parse(received[1].body).source).toBe('startup');
  });

  it('drops a metadata field that does not look like metadata', async () => {
    await startBackend();
    await runReporter(hook({ tool_name: 'rm -rf / SECRET', notification_type: 'SECRET message!' }));
    const body = JSON.parse(received[0].body);
    expect(body.toolName).toBeUndefined();
    expect(body.notificationType).toBeUndefined();
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['empty input', ''],
    ['a JSON array', '[]'],
    ['an unsupported event', hook({ hook_event_name: 'SubagentStop' })],
    ['no Claude session ID', hook({ session_id: undefined })],
    ['a malformed Claude session ID', hook({ session_id: 'a b;c' })],
  ])('exits 0 silently and sends nothing for %s', async (_name, stdin) => {
    await startBackend();
    expectSilentSuccess(await runReporter(stdin));
    expect(received).toHaveLength(0);
  });

  it.each([
    ['no mapping variable', { ECC_TMUX_SESSION: undefined }],
    ['an invalid mapping variable', { ECC_TMUX_SESSION: 'bad name' }],
    ['a claim made outside tmux', { TMUX_PANE: undefined }],
  ])('sends nothing with %s, rather than inventing a mapping', async (_name, env) => {
    await startBackend();
    expectSilentSuccess(await runReporter(hook(), env));
    expect(received).toHaveLength(0);
  });

  it('sends nothing when tmux says the pane belongs to another session', async () => {
    await startBackend();
    fakeTmux('renamed');
    expectSilentSuccess(await runReporter(hook()));
    expect(received).toHaveLength(0);
  });

  it('trusts the variable when tmux cannot answer', async () => {
    await startBackend();
    fakeTmux(null);
    expectSilentSuccess(await runReporter(hook()));
    expect(received).toHaveLength(1);
  });

  it('exits 0 silently when the backend is unavailable', async () => {
    writeCredentials(1);
    const result = await runReporter(hook());
    expectSilentSuccess(result);
    expect(result.ms).toBeLessThan(1000);
  });

  it('exits 0 silently when the credentials file is missing or corrupt', async () => {
    expectSilentSuccess(await runReporter(hook()));
    writeFileSync(join(dir, 'claude-hook.json'), 'not json');
    expectSilentSuccess(await runReporter(hook()));
  });

  it('gives up quickly on a backend that never responds', async () => {
    await startBackend(false);
    const result = await runReporter(hook());
    expectSilentSuccess(result);
    expect(result.ms).toBeLessThan(1500);
  });

  it('exits 0 on a rejected event, returning no decision to Claude', async () => {
    server = createServer((_req, res) => res.writeHead(401).end('{"message":"no"}'));
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
    writeCredentials((server.address() as AddressInfo).port);
    expectSilentSuccess(await runReporter(hook({ hook_event_name: 'PermissionRequest' })));
  });

  it('exits 0 silently when stdin never closes', async () => {
    const result = await new Promise<Result>((done) => {
      const started = Date.now();
      const child = spawn(process.execPath, [REPORTER], {
        env: { PATH: process.env.PATH, ECC_STATE_DIR: dir, ECC_TMUX_SESSION: 'a', TMUX_PANE: '%1' },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('close', (code) => {
        child.stdin.destroy();
        done({ code, stdout, stderr: '', ms: Date.now() - started });
      });
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.ms).toBeLessThan(2500);
  });

  it('handles large tool output', async () => {
    await startBackend();
    const result = await runReporter(hook({ tool_response: 'SECRET'.repeat(500_000) }));
    expectSilentSuccess(result);
    expect(received).toHaveLength(1);
    expect(received[0].body.length).toBeLessThan(1000);
  });
});

describe('hook installer', () => {
  let home: string;
  let settings: string;

  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [INSTALLER, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, ...env },
    });
  }

  const read = () => JSON.parse(readFileSync(settings, 'utf8'));
  const backups = () => readdirSync(join(home, '.claude')).filter((f) => f.includes('ecc-backup'));

  const EXISTING = {
    model: 'opus',
    permissions: { allow: ['Bash(ls:*)'] },
    mcpServers: { custom: { command: 'x' } },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'my-own-stop-hook' }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: 'my-subagent-hook' }] }],
    },
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ecc-installer-'));
    mkdirSync(join(home, '.claude'));
    settings = join(home, '.claude', 'settings.json');
    writeFileSync(settings, JSON.stringify(EXISTING));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('registers the same events the backend accepts', () => {
    expect(run(['install']).status).toBe(0);
    expect(Object.keys(read().hooks).filter((e) => e !== 'SubagentStop').sort()).toEqual(
      [...CLAUDE_HOOK_EVENTS].sort(),
    );
  });

  it('reports the same events the backend accepts', () => {
    const source = readFileSync(REPORTER, 'utf8');
    for (const event of CLAUDE_HOOK_EVENTS) expect(source).toContain(`'${event}'`);
  });

  it('preserves unrelated settings and other hooks', () => {
    run(['install']);
    const result = read();
    expect(result.model).toBe('opus');
    expect(result.permissions).toEqual(EXISTING.permissions);
    expect(result.mcpServers).toEqual(EXISTING.mcpServers);
    expect(result.hooks.Stop[0]).toEqual(EXISTING.hooks.Stop[0]);
    expect(result.hooks.Stop).toHaveLength(2);
    expect(result.hooks.SubagentStop).toEqual(EXISTING.hooks.SubagentStop);
  });

  it('shows what it will add, and changes nothing in a dry run', () => {
    const before = readFileSync(settings, 'utf8');
    const result = run(['install', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PermissionRequest');
    expect(result.stdout).toContain('Dry run');
    expect(readFileSync(settings, 'utf8')).toBe(before);
    expect(backups()).toHaveLength(0);
  });

  it('creates a backup of the original before changing it', () => {
    const before = readFileSync(settings, 'utf8');
    run(['install']);
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(home, '.claude', backups()[0]), 'utf8')).toBe(before);
  });

  it('is idempotent, with no duplicates and no extra backups', () => {
    run(['install']);
    const once = readFileSync(settings, 'utf8');
    const result = run(['install']);
    expect(result.stdout).toContain('Already installed');
    expect(readFileSync(settings, 'utf8')).toBe(once);
    expect(backups()).toHaveLength(1);
  });

  it('replaces an entry from an older checkout rather than adding another', () => {
    run(['install']);
    const raw = readFileSync(settings, 'utf8').replaceAll(SCRIPTS, '/old/checkout/scripts');
    writeFileSync(settings, raw);
    run(['install']);
    expect(read().hooks.PreToolUse).toHaveLength(1);
    expect(read().hooks.PreToolUse[0].hooks[0].command).toContain(SCRIPTS);
  });

  it('uninstalls only its own hooks', () => {
    run(['install']);
    run(['uninstall']);
    expect(read()).toEqual(EXISTING);
  });

  it('keeps a handler someone added to the same group when uninstalling', () => {
    run(['install']);
    const current = read();
    current.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'neighbor' });
    writeFileSync(settings, JSON.stringify(current));
    run(['uninstall']);
    expect(read().hooks.PreToolUse[0].hooks).toEqual([{ type: 'command', command: 'neighbor' }]);
  });

  it('does nothing when uninstalling with nothing installed', () => {
    const before = readFileSync(settings, 'utf8');
    expect(run(['uninstall']).stdout).toContain('Not installed');
    expect(readFileSync(settings, 'utf8')).toBe(before);
    expect(backups()).toHaveLength(0);
  });

  it('creates the file when there is none', () => {
    rmSync(settings);
    expect(run(['install']).status).toBe(0);
    expect(Object.keys(read().hooks)).toContain('Stop');
  });

  it.each([
    ['invalid JSON', '{ not json'],
    ['a non-object', '[]'],
    ['a malformed hooks value', '{"hooks":{"Stop":"nope"}}'],
  ])('refuses to touch a file containing %s', (_name, content) => {
    writeFileSync(settings, content);
    const result = run(['install']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('left alone');
    expect(readFileSync(settings, 'utf8')).toBe(content);
    expect(backups()).toHaveLength(0);
  });

  it('keeps a symlinked settings file a symlink', () => {
    const real = join(home, 'dotfiles-settings.json');
    writeFileSync(real, JSON.stringify(EXISTING));
    rmSync(settings);
    symlinkSync(real, settings);
    run(['install']);
    expect(JSON.parse(readFileSync(real, 'utf8')).hooks.PreToolUse).toHaveLength(1);
    expect(read().hooks.PreToolUse).toHaveLength(1);
  });

  it('keeps the file mode', () => {
    chmodSync(settings, 0o640);
    run(['install']);
    expect(statSync(settings).mode & 0o777).toBe(0o640);
  });

  it('honors CLAUDE_CONFIG_DIR', () => {
    const other = join(home, 'other-config');
    mkdirSync(other);
    run(['install'], { CLAUDE_CONFIG_DIR: other });
    expect(existsSync(join(other, 'settings.json'))).toBe(true);
    expect(read()).toEqual(EXISTING);
  });

  it('reports status without changing anything', () => {
    const before = readFileSync(settings, 'utf8');
    const result = run(['status']);
    expect(result.stdout).toContain('Installed for: nothing');
    expect(result.stdout).toContain('Other hooks: 2');
    expect(readFileSync(settings, 'utf8')).toBe(before);
  });

  it('rejects an unknown command or flag', () => {
    expect(run(['destroy']).status).toBe(1);
    expect(run(['install', '--force']).status).toBe(1);
  });

  describe('the installed command', () => {
    const command = () => read().hooks.Stop[1].hooks[0].command as string;
    const sh = (env: Record<string, string>) =>
      spawnSync('sh', ['-c', command()], {
        input: '{}',
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: home, ...env },
      });

    beforeEach(() => run(['install']));

    it('sets a short hook timeout', () => {
      expect(read().hooks.Stop[1].hooks[0].timeout).toBeLessThanOrEqual(5);
    });

    it('exits 0 without output outside a monitored session', () => {
      expect(sh({})).toMatchObject({ status: 0, stdout: '', stderr: '' });
    });

    it('exits 0 without output inside a monitored session', () => {
      expect(sh({ ECC_TMUX_SESSION: 'a', TMUX_PANE: '%1' })).toMatchObject({
        status: 0,
        stdout: '',
        stderr: '',
      });
    });

    it('exits 0 without output even when the reporter has moved', () => {
      const raw = readFileSync(settings, 'utf8').replaceAll(SCRIPTS, '/moved/away');
      writeFileSync(settings, raw);
      expect(sh({ ECC_TMUX_SESSION: 'a', TMUX_PANE: '%1' })).toMatchObject({
        status: 0,
        stdout: '',
        stderr: '',
      });
    });
  });
});
